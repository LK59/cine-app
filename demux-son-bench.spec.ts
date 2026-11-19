// Banc de l'essai demux-son (19/11/2026) — sauté sans DS_TRACKS.
//
// Compare, sur de vrais fichiers, le son décodé par le chemin actuel (mediabunny lit le conteneur ET
// décode) et par l'essai (notre lecteur lit le conteneur, le décodeur reste le même) :
//
// - `packets` : les paquets de la piste depuis chaque instant — mediabunny (`EncodedPacketSink`) et
//   nous (`audioPacketsFrom`) : empreinte des octets et des instants. Couvre l'Opus et l'AAC, que
//   Node ne décode pas ;
// - `decoded` : `SoftwareAudioTrack.samples(t)` par les deux chemins, `DS_SECONDS` de plans Float32 :
//   empreinte des octets et des instants de chaque trame, nombre d'images, premier/dernier instant ;
// - le **coût** : octets demandés au fichier, nombre de lectures, blocs de 1 Mio distincts touchés
//   (ce que le cache du lecteur irait chercher), millisecondes — pour l'ouverture et pour chaque saut.
//
// Une ligne JSON par piste dans DS_OUT. DS_TRACKS : `chemin\tpiste\tcodec\tcanaux` par ligne.
import { it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { SoftwareAudioTrack, takeOwnDemux } from "@/lib/webcodecs/softwareAudio";
import { audioPacketsFrom } from "@/lib/webcodecs/audioDemux";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

const WINDOW = Number(process.env.DS_SECONDS ?? 30);
const NODE_DECODES = new Set(["A_AC3", "A_EAC3", "A_DTS", "A_FLAC"]);
const CHUNK = 1 << 20;

interface Counted extends ByteSource {
  cost(): { reads: number; bytes: number; chunks: number };
  reset(): void;
}

function countedSource(path: string): Counted {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  let reads = 0;
  let bytes = 0;
  let chunks = new Set<number>();
  return {
    size,
    read: async (start: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - start));
      reads += 1;
      bytes += length;
      for (let c = Math.floor(start / CHUNK); c <= Math.floor((start + Math.max(0, length - 1)) / CHUNK); c++) chunks.add(c);
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
    cost: () => ({ reads, bytes, chunks: chunks.size }),
    reset: () => {
      reads = 0;
      bytes = 0;
      chunks = new Set();
    },
  };
}

const r6 = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6);
const errorOf = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

async function decodedFrom(track: SoftwareAudioTrack, from: number) {
  const hash = createHash("sha256");
  let frames = 0;
  let blocks = 0;
  let first: number | null = null;
  let last: number | null = null;
  let channels = 0;
  const t0 = performance.now();
  let firstMs: number | null = null;
  for await (const d of track.samples(from)) {
    firstMs ??= performance.now() - t0;
    if (d.timestampSeconds >= from + WINDOW) break;
    channels = d.planes.length;
    for (const p of d.planes) hash.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    hash.update(`|${d.timestampSeconds}|${d.sampleRate}|`);
    frames += d.planes[0]?.length ?? 0;
    blocks += 1;
    first ??= d.timestampSeconds;
    last = d.timestampSeconds;
  }
  return { frames, blocks, channels, first: r6(first), last: r6(last), hash: hash.digest("hex").slice(0, 20), ms: Math.round(performance.now() - t0), firstMs: firstMs === null ? null : Math.round(firstMs) };
}

type Core = typeof import("mediabunny");

async function mbPackets(core: Core, source: ByteSource, iso: boolean, trackNumber: number, from: number) {
  const input = new core.Input({
    formats: [iso ? new core.Mp4InputFormat() : new core.MatroskaInputFormat()],
    source: new core.CustomSource({ getSize: () => source.size, read: (s, e) => source.read(s, e - s) }),
  });
  const track = (await input.getAudioTracks()).find((t) => t.id === trackNumber);
  if (!track) return { error: "piste absente pour mediabunny" };
  const sink = new core.EncodedPacketSink(track);
  const startPacket = (await sink.getKeyPacket(from)) ?? (await sink.getFirstKeyPacket());
  return hashPackets(startPacket ? sink.packets(startPacket) : emptyIter(), from);
}

async function* emptyIter() {}

async function hashPackets(packets: AsyncIterable<{ data: Uint8Array; timestamp: number; duration: number }>, from: number) {
  const hash = createHash("sha256");
  let count = 0;
  let first: number | null = null;
  let last: number | null = null;
  for await (const p of packets) {
    if (p.timestamp >= from + WINDOW) break;
    hash.update(p.data);
    hash.update(`|${r6(p.timestamp)}|`);
    count += 1;
    first ??= p.timestamp;
    last = p.timestamp;
  }
  return { count, first: r6(first), last: r6(last), hash: hash.digest("hex").slice(0, 20) };
}

it.skipIf(!process.env.DS_TRACKS)(
  "demux-son : mediabunny contre nos paquets",
  async () => {
    const core = await import("mediabunny");
    const lines = readFileSync(process.env.DS_TRACKS!, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const [path, n, codecId, ch] = line.split("\t");
      const trackNumber = Number(n);
      const row: Record<string, unknown> = { path: path.replace("/mnt/media/video/", ""), track: trackNumber, codec: codecId, ch: Number(ch) };
      const header = countedSource(path);
      const srcA = countedSource(path);
      const srcB = countedSource(path);
      try {
        const file = await openMediaFile(header);
        const duration = file.durationSeconds ?? 0;
        row.durationS = Math.round(duration);
        const iso = !!file.mp4;
        // L'instant 0, le quart, la moitié, les trois quarts, la dernière minute, et au-delà de la fin.
        const points = [0, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0, duration - 60), duration + 5].map((x) => Math.round(x * 1000) / 1000);
        row.points = points;

        // Les paquets, des deux côtés, pour toutes les pistes.
        const packets = [];
        for (const from of points) {
          const mb = await mbPackets(core, srcA, iso, trackNumber, from).catch((e) => ({ error: errorOf(e) }));
          const ours = await hashPackets(audioPacketsFrom(srcB, file, trackNumber, from), from).catch((e) => ({ error: errorOf(e) }));
          packets.push({ from, same: "hash" in mb && "hash" in ours && mb.hash === ours.hash, mb, ours });
        }
        row.packets = packets;
        srcA.reset();
        srcB.reset();

        if (NODE_DECODES.has(codecId)) {
          // L'ouverture : mediabunny relit en-tête et index ; nous, rien (le fichier est déjà lu).
          // Nos paquets d'abord : c'est le premier enregistrement des décodeurs de mediabunny qui en note
          // les classes (decoderClasses.ts, réservé à ce chemin de comparaison).
          let t0 = performance.now();
          const b = await SoftwareAudioTrack.open(srcB, trackNumber, codecId, file, { demux: "nôtre" });
          const own = takeOwnDemux();
          const openB = { ms: Math.round(performance.now() - t0), ...srcB.cost(), decoder: own?.decoder ?? "?" };
          t0 = performance.now();
          const a = await SoftwareAudioTrack.open(srcA, trackNumber, codecId, file);
          const openA = { ms: Math.round(performance.now() - t0), ...srcA.cost() };
          row.open = { mb: openA, ours: openB };
          const decoded = [];
          for (const from of points) {
            srcA.reset();
            srcB.reset();
            const da = await decodedFrom(a, from).catch((e) => ({ error: errorOf(e) }));
            const ca = srcA.cost();
            const db = await decodedFrom(b, from).catch((e) => ({ error: errorOf(e) }));
            const cb = srcB.cost();
            decoded.push({ from, same: "hash" in da && "hash" in db && da.hash === db.hash, mb: { ...da, ...ca }, ours: { ...db, ...cb } });
          }
          row.decoded = decoded;
          row.ownStats = own?.stats;
          a.close();
          b.close();
        }
      } catch (e) {
        row.error = errorOf(e);
      } finally {
        header.close?.();
        srcA.close?.();
        srcB.close?.();
      }
      appendFileSync(process.env.DS_OUT!, JSON.stringify(row) + "\n");
    }
  },
  6 * 3_600_000
);
