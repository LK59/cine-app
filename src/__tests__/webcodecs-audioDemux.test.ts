import { describe, it, expect } from "vitest";
import { MemoryByteSource, type ByteSource } from "@/lib/webcodecs/byteSource";
import { parseMatroska } from "@/lib/webcodecs/matroska";
import { audioPacketsFrom, decodedFrom, newAudioDemuxStats, GIVE_UP_S, type DemuxedAudioPacket, type RawFrame } from "@/lib/webcodecs/audioDemux";

// Un petit écrivain Matroska (le même principe que webcodecs-matroska.test.ts) : de vrais octets,
// pour que nos paquets soient lus comme ceux d'un fichier.

function vint(value: number): Uint8Array {
  let w = 1;
  while (value >= 2 ** (7 * w) - 1 && w < 8) w++;
  const out = new Uint8Array(w);
  let v = value;
  for (let i = w - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (w - 1);
  return out;
}
function idBytes(id: number): Uint8Array {
  const parts: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) parts.unshift(v & 0xff);
  return new Uint8Array(parts);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function el(id: number, payload: Uint8Array): Uint8Array {
  return concat(idBytes(id), vint(payload.length), payload);
}
function uint(value: number, bytes = 1): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}
function f64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}
/** Un SimpleBlock ; `frames` > 1 : laçage fixe (toutes les trames de même taille). */
function block(track: number, relative: number, frames: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = 0x80 | track;
  new DataView(header.buffer).setInt16(1, relative);
  header[3] = 0x80 | (frames.length > 1 ? 0x04 : 0);
  return el(0xa3, concat(header, frames.length > 1 ? new Uint8Array([frames.length - 1]) : new Uint8Array(), ...frames));
}
const VIDEO = 1;
const AUDIO = 2;

/**
 * Un fichier de `seconds` secondes, un cluster par seconde : une image vidéo par cluster, et un
 * paquet son toutes les 250 ms jusqu'à `audioEndS` (exclu) — un doublage plus court que le film.
 * Le premier cluster porte un bloc son laçé de deux trames à 0 ms.
 */
function buildFile(seconds: number, audioEndS = seconds, gap: [number, number] | null = null): Uint8Array {
  const info = el(0x1549a966, concat(el(0x2ad7b1, uint(1_000_000, 4)), el(0x4489, f64(seconds * 1000))));
  const track = (n: number, type: number, codec: string, extra: Uint8Array) =>
    el(0xae, concat(el(0xd7, uint(n)), el(0x83, uint(type)), el(0x86, new TextEncoder().encode(codec)), extra));
  const tracks = el(
    0x1654ae6b,
    concat(
      track(VIDEO, 1, "V_MPEGH/ISO/HEVC", el(0xe0, concat(el(0xb0, uint(1920, 2)), el(0xba, uint(1080, 2))))),
      track(AUDIO, 2, "A_AC3", el(0xe1, concat(el(0xb5, f64(48000)), el(0x9f, uint(6)))))
    )
  );
  const clusters: Uint8Array[] = [];
  for (let s = 0; s < seconds; s++) {
    const blocks: Uint8Array[] = [block(VIDEO, 0, [new Uint8Array(400).fill(s & 0xff)])];
    for (let q = 0; q < 4; q++) {
      const ms = s * 1000 + q * 250;
      if (ms >= audioEndS * 1000) break;
      if (gap && ms >= gap[0] * 1000 && ms < gap[1] * 1000) continue;
      // Le tout premier : deux trames laçées, qui couvrent 0–250 ms à elles deux.
      const frames = s === 0 && q === 0 ? [new Uint8Array([0, 1]), new Uint8Array([0, 2])] : [new Uint8Array([s & 0xff, q])];
      blocks.push(block(AUDIO, q * 250, frames));
    }
    clusters.push(el(0x1f43b675, concat(el(0xe7, uint(s * 1000, 4)), ...blocks)));
  }
  return concat(el(0x1a45dfa3, el(0x4286, uint(1))), el(0x18538067, concat(info, tracks, ...clusters)));
}

/** Compte ce que le lecteur demande au fichier. */
function counted(bytes: Uint8Array): ByteSource & { readBytes: number } {
  const inner = new MemoryByteSource(bytes);
  const out = {
    size: inner.size,
    readBytes: 0,
    read: async (offset: number, length: number) => {
      out.readBytes += Math.max(0, Math.min(length, inner.size - offset));
      return inner.read(offset, length);
    },
    close: () => {},
  };
  return out;
}

async function collect(gen: AsyncIterable<DemuxedAudioPacket>): Promise<DemuxedAudioPacket[]> {
  const out: DemuxedAudioPacket[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

describe("audioPacketsFrom — nos paquets, aux instants de mediabunny", () => {
  it("commence au dernier paquet dont l'instant est ≤ à celui demandé", async () => {
    const bytes = buildFile(5);
    const source = new MemoryByteSource(bytes);
    const file = await parseMatroska(source);
    const packets = await collect(audioPacketsFrom(source, file, AUDIO, 2.6));
    expect(packets[0].timestamp).toBe(2.5);
    expect(packets[1].timestamp).toBe(2.75);
    expect(packets.at(-1)!.timestamp).toBe(4.75);
  });

  it("pile sur un paquet : celui-là, pas le précédent", async () => {
    const source = new MemoryByteSource(buildFile(5));
    const file = await parseMatroska(source);
    const packets = await collect(audioPacketsFrom(source, file, AUDIO, 3));
    expect(packets[0].timestamp).toBe(3);
  });

  it("étale les trames d'un bloc laçé sur sa durée (l'écart jusqu'au bloc suivant)", async () => {
    const source = new MemoryByteSource(buildFile(3));
    const file = await parseMatroska(source);
    const packets = await collect(audioPacketsFrom(source, file, AUDIO, 0));
    expect(packets.slice(0, 3).map((p) => p.timestamp)).toEqual([0, 0.125, 0.25]);
    expect(packets[0].duration).toBeCloseTo(0.125);
    expect([...packets[1].data]).toEqual([0, 2]);
  });

  it("une piste finie avant le film : le dernier paquet, puis on s'arrête sans lire jusqu'à la fin", async () => {
    const seconds = 200;
    const bytes = buildFile(seconds, 10);
    const source = counted(bytes);
    const file = await parseMatroska(source);
    source.readBytes = 0;
    const stats = newAudioDemuxStats();
    const packets = await collect(audioPacketsFrom(source, file, AUDIO, 100, stats));
    expect(packets.map((p) => p.timestamp)).toEqual([9.75]);
    // Pas d'index : on part du premier cluster ; l'abandon tombe à GIVE_UP_S après le dernier paquet
    // (le lecteur lit un peu devant : dix secondes de marge), loin des 200 s du fichier.
    expect(stats.gaveUp).toBe(1);
    const perSecond = bytes.length / seconds;
    expect(source.readBytes).toBeLessThan(perSecond * (10 + GIVE_UP_S + 10));
  });

  it("un trou au milieu de la piste se traverse : rien n'est abandonné une fois parti", async () => {
    // Relecture du 19/11/2026 : couper après GIVE_UP_S de silence aurait laissé la suite du film sans son.
    const source = new MemoryByteSource(buildFile(200, 200, [20, 20 + GIVE_UP_S + 30]));
    const file = await parseMatroska(source);
    const stats = newAudioDemuxStats();
    const packets = await collect(audioPacketsFrom(source, file, AUDIO, 10, stats));
    expect(stats.gaveUp).toBe(0);
    expect(packets.some((p) => p.timestamp > 20 + GIVE_UP_S + 30)).toBe(true);
    expect(packets.at(-1)!.timestamp).toBe(199.75);
  });

  it("une lecture abandonnée cesse de lire au tour suivant", async () => {
    const bytes = buildFile(200, 10);
    const source = counted(bytes);
    const file = await parseMatroska(source);
    source.readBytes = 0;
    const cancel = { stopped: false };
    const gen = audioPacketsFrom(source, file, AUDIO, 100, newAudioDemuxStats(), cancel);
    const pending = gen.next();
    cancel.stopped = true;
    await pending;
    // Arrêté avant la fin de la recherche (GIVE_UP_S de fichier) : à peine un cluster lu.
    expect(source.readBytes).toBeLessThan(bytes.length / 200 * 5);
  });

  it("demandé avant le premier paquet : le premier", async () => {
    const source = new MemoryByteSource(buildFile(3));
    const file = await parseMatroska(source);
    const packets = await collect(audioPacketsFrom(source, file, AUDIO, -1));
    expect(packets[0].timestamp).toBe(0);
  });
});

describe("decodedFrom — horloge et tri du décodé, comme AudioSampleSink", () => {
  // Un faux décodeur : chaque paquet rend une trame de 12 000 images (250 ms à 48 kHz) à son instant.
  const fakeOpener = (jitter = 0) => async (onFrame: (f: RawFrame) => void) => ({
    decode: async (p: DemuxedAudioPacket) => {
      onFrame({ planes: [new Float32Array(12_000)], sampleRate: 48000, timestamp: p.timestamp + jitter });
    },
    flush: async () => {},
    close: () => {},
  });
  const packetsAt = async function* (times: number[]) {
    for (const t of times) yield { data: new Uint8Array(1), timestamp: t, duration: 0.25 };
  };

  it("garde la trame qui contient l'instant demandé, puis toutes les suivantes", async () => {
    const out = [];
    for await (const f of decodedFrom(packetsAt([2.5, 2.75, 3]), fakeOpener(), 2.6, 48000)) out.push(f.timestampSeconds);
    expect(out).toEqual([2.5, 2.75, 3]);
  });

  it("une horloge cumulée : un décodeur qui dérive de moins d'une trame ne la décale pas", async () => {
    const out = [];
    for await (const f of decodedFrom(packetsAt([0, 0.25, 0.5]), fakeOpener(0.01), 0, 48000)) out.push(f.timestampSeconds);
    expect(out).toEqual([0.01, 0.26, 0.51]);
  });
});
