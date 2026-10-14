// Banc de non-régression de mediabunny — sauté sans MB_FILES.
//
// Écrit pour la montée de mediabunny (et de @mediabunny/ac3, @mediabunny/dts) de 1.58.1 à 1.61.4,
// le 14/10/2026 : lancé sur le code avant et après une montée de version, chaque ligne doit être
// identique. Pour chaque fichier (un chemin par ligne dans MB_FILES) et chaque piste audio, il
// écrit dans MB_OUT une ligne JSON qui couvre les trois choses que mediabunny fait ici :
//
// - **ce qu'il trouve** : ses pistes audio (numéro, codec, canaux, fréquence, langue), la durée
//   et le premier instant qu'il calcule ;
// - **ce qu'il démultiplexe** (`packets`) : depuis 0 s et trois instants de saut (le quart, la
//   moitié, les trois quarts de la durée que lit *notre* lecteur Matroska, pas la sienne), 60 s de
//   paquets — empreinte des octets, des instants, des durées et des types. Couvre toutes les
//   pistes, l'Opus et l'AAC compris, que le navigateur décode et que Node ne sait pas décoder ;
// - **ce qu'il décode** (`decoded`) : par `SoftwareAudioTrack.samples()`, le chemin même du
//   lecteur, 60 s de plans Float32 depuis les mêmes instants — empreinte des octets de chaque
//   plan, nombre d'images, premier et dernier instant ;
// - **ce que reçoit l'encodeur et ce que le remultiplexeur en fait** (`remux`) : le
//   remultiplexeur ouvert à chaque instant, avec un `AudioEncoder` factice et déterministe dont
//   chaque trame est l'empreinte des échantillons entrelacés qu'on lui a donnés. L'empreinte des
//   segments audio dit donc à la fois le son livré à l'encodeur et son découpage. Le refus de
//   `MediaSource` est simulé pour AC-3, E-AC-3, DTS, FLAC et Opus : ce qu'un iPhone ou Chrome ne
//   prend pas tel quel, donc ce qui passe par un décodeur.
//
//   docker run --rm --cpus=3 --name mb-bench -v "$PWD":/app -v /mnt/media/video:/mnt/media/video:ro -w /app \
//     -e MB_FILES=/app/mb-files.txt -e MB_OUT=/app/mb-out.jsonl node:24-alpine \
//     npx vitest run mediabunny-regress-bench.spec.ts
//
// `MB_SECONDS` raccourcit la fenêtre (60 par défaut), `MB_NO_REMUX=1` saute la troisième partie.
import { describe, it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync, appendFileSync } from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

const WINDOW = Number(process.env.MB_SECONDS ?? 60);

// Ce que le navigateur simulé refuse dans MediaSource : tout ce qui, chez l'un ou l'autre des
// navigateurs de la maison, part vers un décodeur logiciel.
const REFUSED = /ac-3|ec-3|dts|dtsc|dtsh|dtsl|dtse|flac|opus/i;
const anySource = { isTypeSupported: (mime: string) => !REFUSED.test(mime) };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

class FakeAudioData {
  constructor(readonly init: { numberOfFrames: number; numberOfChannels: number; sampleRate: number; timestamp: number; data: Float32Array }) {}
  close() {}
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Une AudioSpecificConfig AAC-LC valide pour la forme demandée — ce que décrirait un vrai encodeur. */
function ascFor(sampleRate: number, channels: number): Uint8Array {
  const index = Math.max(0, SAMPLE_RATES.indexOf(sampleRate));
  const config = channels === 8 ? 7 : Math.min(channels, 6);
  return new Uint8Array([(2 << 3) | (index >> 1), ((index & 1) << 7) | (config << 3)]);
}

/**
 * Un encodeur AAC qui n'encode rien : il découpe en trames de 1024 images comme un vrai, et chaque
 * trame porte l'empreinte de tout ce qu'il a reçu jusque-là. Deux sorties identiques veulent dire
 * deux entrées identiques, à l'octet.
 */
class FakeAudioEncoder {
  static async isConfigSupported(config: unknown) {
    return { supported: true, config };
  }
  state = "unconfigured";
  encodeQueueSize = 0;
  private hash: Hash = createHash("sha256");
  private held = 0;
  private heldFrom = 0;
  private described = false;
  private config: { sampleRate: number; numberOfChannels: number } = { sampleRate: 48000, numberOfChannels: 2 };
  constructor(private readonly init: { output: (c: unknown, m?: unknown) => void; error: (e: unknown) => void }) {}
  configure(config: { sampleRate: number; numberOfChannels: number }) {
    this.config = config;
    this.state = "configured";
  }
  encode(data: FakeAudioData) {
    const { data: floats, numberOfFrames, timestamp, sampleRate } = data.init;
    this.hash.update(new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength));
    this.hash.update(`|${numberOfFrames}@${timestamp}|`);
    const frameUs = Math.round((1024 / sampleRate) * 1e6);
    if (this.held === 0) this.heldFrom = timestamp;
    this.held += numberOfFrames;
    while (this.held >= 1024) {
      this.emit(this.heldFrom, frameUs);
      this.heldFrom += frameUs;
      this.held -= 1024;
    }
  }
  private emit(timestamp: number, duration: number) {
    const bytes = this.hash.copy().digest().subarray(0, 16);
    const metadata = this.described ? undefined : { decoderConfig: { description: ascFor(this.config.sampleRate, this.config.numberOfChannels) } };
    this.described = true;
    this.init.output({ type: "key", timestamp, duration, byteLength: bytes.byteLength, copyTo: (d: Uint8Array) => d.set(bytes) }, metadata);
  }
  async flush() {
    if (this.held > 0) {
      this.emit(this.heldFrom, Math.round((1024 / this.config.sampleRate) * 1e6));
      this.held = 0;
    }
  }
  reset() {
    this.held = 0;
    this.state = "unconfigured";
  }
  close() {
    this.state = "closed";
  }
}
(globalThis as unknown as { AudioData: unknown }).AudioData = FakeAudioData;
(globalThis as unknown as { AudioEncoder: unknown }).AudioEncoder = FakeAudioEncoder;

function fileSource(path: string): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    read: async (start: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - start));
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      return new Uint8Array(buffer.subarray(0, read));
    },
    close: () => closeSync(fd),
  };
}

const r6 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? n ?? null : Math.round(n * 1e6) / 1e6);
const short = (h: Hash) => h.digest("hex").slice(0, 24);
const errorOf = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

type Core = typeof import("mediabunny");

/** Ce que mediabunny trouve dans le fichier, lu par une entrée neuve, sans rien de nos modules. */
async function listing(core: Core, source: ByteSource, iso: boolean) {
  const input = new core.Input({
    formats: [iso ? new core.Mp4InputFormat() : new core.MatroskaInputFormat()],
    source: new core.CustomSource({ getSize: () => source.size, read: (start, end) => source.read(start, end - start) }),
  });
  const tracks = await input.getAudioTracks();
  const described = [];
  for (const t of tracks) {
    let duration: number | string;
    let first: number | string;
    try {
      duration = r6(await t.computeDuration())!;
    } catch (e) {
      duration = `erreur: ${errorOf(e)}`;
    }
    try {
      first = r6(await t.getFirstTimestamp())!;
    } catch (e) {
      first = `erreur: ${errorOf(e)}`;
    }
    described.push({ id: t.id, codec: t.codec, channels: t.numberOfChannels, sampleRate: t.sampleRate, language: t.languageCode, duration, first });
  }
  return { input, described };
}

async function packetsFrom(core: Core, track: InstanceType<Core["InputAudioTrack"]>, from: number) {
  const sink = new core.EncodedPacketSink(track);
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  let first: number | null = null;
  let last: number | null = null;
  const start = await sink.getPacket(from);
  if (!start) return { from: r6(from), count: 0 };
  for await (const packet of sink.packets(start)) {
    if (packet.timestamp >= from + WINDOW) break;
    hash.update(packet.data);
    hash.update(`|${packet.timestamp}|${packet.duration}|${packet.type}|`);
    count += 1;
    bytes += packet.byteLength;
    first ??= packet.timestamp;
    last = packet.timestamp;
  }
  return { from: r6(from), count, bytes, first: r6(first), last: r6(last), hash: short(hash) };
}

async function decodedFrom(track: SoftwareAudioTrack, from: number) {
  const hash = createHash("sha256");
  let blocks = 0;
  let frames = 0;
  let first: number | null = null;
  let last: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  for await (const decoded of track.samples(from)) {
    if (decoded.timestampSeconds >= from + WINDOW) break;
    channels = decoded.planes.length;
    sampleRate = decoded.sampleRate;
    for (const plane of decoded.planes) hash.update(new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength));
    hash.update(`|${decoded.timestampSeconds}|${decoded.sampleRate}|`);
    blocks += 1;
    frames += decoded.planes[0]?.length ?? 0;
    first ??= decoded.timestampSeconds;
    last = decoded.timestampSeconds;
  }
  return { from: r6(from), blocks, frames, channels, sampleRate, first: r6(first), last: r6(last), hash: short(hash) };
}

describe.skipIf(!process.env.MB_FILES)("non-régression mediabunny", () => {
  it("trouve, démultiplexe, décode et livre les mêmes octets", { timeout: 6 * 3_600_000 }, async () => {
    const core = await import("mediabunny");
    const files = readFileSync(process.env.MB_FILES!, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const path of files) {
      const name = path.split("/").pop();
      let source: ByteSource;
      try {
        source = fileSource(path);
      } catch (e) {
        // Un nom introuvable (une espace insécable dans un nom de Radarr) : noté, et le banc continue.
        appendFileSync(process.env.MB_OUT!, JSON.stringify({ file: name, error: errorOf(e) }) + "\n");
        continue;
      }
      try {
        const file = await openMediaFile(source);
        const iso = file.mp4 !== undefined;
        const duration = file.durationSeconds ?? 0;
        const positions = [0, duration * 0.25, duration * 0.5, duration * 0.75].map((s) => Math.floor(s));
        const { described } = await listing(core, source, iso).catch((e) => ({ described: `erreur: ${errorOf(e)}` }) as never);
        appendFileSync(process.env.MB_OUT!, JSON.stringify({ file: name, container: iso ? "mp4" : "mkv", duration: r6(duration), mediabunnyTracks: described }) + "\n");
        const video = file.tracks.find((t) => t.type === "video");
        for (const audio of file.tracks.filter((t) => t.type === "audio")) {
          const row: Record<string, unknown> = { file: name, track: audio.number, codec: audio.codecId, channels: audio.audio?.channels, rate: audio.audio?.sampleRate };
          const t0 = Date.now();
          // 1. Le démultiplexage, par une entrée neuve à chaque piste.
          try {
            const { input } = await listing(core, source, iso);
            const mb = (await input.getAudioTracks()).find((t) => t.id === audio.number);
            row.packets = mb ? await Promise.all(positions.map((p) => packetsFrom(core, mb, p))) : "piste absente chez mediabunny";
          } catch (e) {
            row.packets = `erreur: ${errorOf(e)}`;
          }
          // 2. Le décodé, par le chemin du lecteur. Une source neuve : le lecteur de conteneur
          // partagé (WeakMap par source) est celui du lecteur, comme en vrai, mais propre à la piste.
          const decodeSource = fileSource(path);
          try {
            const track = await SoftwareAudioTrack.open(decodeSource, audio.number, audio.codecId, file);
            try {
              row.format = track.format;
              const runs = [];
              for (const p of positions) runs.push(await decodedFrom(track, p));
              row.decoded = runs;
            } finally {
              track.close();
            }
          } catch (e) {
            row.decoded = `erreur: ${errorOf(e)}`;
          } finally {
            decodeSource.close();
          }
          // 3. Le remultiplexeur, encodeur factice.
          if (video && process.env.MB_NO_REMUX !== "1") {
            const runs = [];
            for (const p of positions) {
              const remuxSource = fileSource(path);
              try {
                const remuxer = await Remuxer.open(remuxSource, file, video, audio, { width: 1920, height: 1080 }, null, p, { perTrack: true });
                // Comme une reconstruction du lecteur à cet instant : ouvert là, puis placé là.
                if (p > 0) remuxer.seekTo(p);
                const plan = remuxer.plan();
                const hash = createHash("sha256");
                if (plan.audioInit) hash.update(plan.audioInit);
                let bytes = 0;
                let segments = 0;
                let end = 0;
                for (let i = 0; i < 200; i++) {
                  const segment = await remuxer.nextSegment();
                  if (!segment) break;
                  segments += 1;
                  if (segment.audio) {
                    hash.update(segment.audio);
                    bytes += segment.audio.byteLength;
                  }
                  end = segment.endSeconds;
                  if (end >= p + WINDOW) break;
                }
                runs.push({ from: p, mime: plan.audioMimeType, transcoded: remuxer.diagnostics().transcodedAudio, segments, bytes, end: r6(end), hash: short(hash) });
                remuxer.close();
              } catch (e) {
                runs.push({ from: p, error: errorOf(e) });
              } finally {
                remuxSource.close();
              }
            }
            row.remux = runs;
          }
          row.ms = Date.now() - t0;
          appendFileSync(process.env.MB_OUT!, JSON.stringify(row) + "\n");
        }
      } finally {
        source.close();
      }
    }
  });
});
