// Banc de référence du son décodé — sauté sans AR_TRACKS (DECISIONS.md §197, 19/11/2026).
//
// Le successeur de mediabunny-regress-bench.spec.ts : mediabunny retiré, la référence est notre propre
// chaîne, prouvée identique à l'échantillon près à mediabunny sur 100 pistes de la bibliothèque avant
// son retrait. Lancé sur le code avant et après un changement (lecteur de paquets, module FFmpeg,
// libFLAC, montée de version), chaque ligne doit être identique — sauf `ms`.
//
// Une ligne JSON par piste dans AR_OUT. AR_TRACKS : `chemin\tpiste\tcodec\tcanaux` par ligne. Pour
// chaque instant (début, quart, moitié, trois quarts, dernière minute) :
// - `packets` : les paquets que notre lecteur rend (empreinte des octets et des instants) — toutes les
//   pistes, l'Opus, l'AAC et le MP3 compris ;
// - `decoded` : le son décodé par `SoftwareAudioTrack.samples()`, le chemin même du lecteur, sur
//   `AR_SECONDS` (30 par défaut) — empreinte des plans Float32 et des instants, images, canaux. Pour
//   les codecs que Node décode : AC-3, E-AC3, DTS, FLAC, PCM, TrueHD (l'Opus, l'AAC et le MP3 passent
//   par l'AudioDecoder d'un navigateur).
//
//   docker run --rm --cpus=4 --name audio-ref -v "$PWD":/app -v /mnt/media/video:/mnt/media/video:ro -w /app \
//     -e AR_TRACKS=/app/pistes.tsv -e AR_OUT=/app/ref.jsonl node:26-alpine npx vitest run audio-ref-bench.spec.ts
//
// Comparer deux passages : `diff <(jq -c 'del(.. | .ms?)' a.jsonl) <(jq -c 'del(.. | .ms?)' b.jsonl)`.
import { it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";
import { audioPacketsFrom } from "@/lib/webcodecs/audioDemux";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

const WINDOW = Number(process.env.AR_SECONDS ?? 30);
const NODE_DECODES = /^A_(AC3|EAC3|DTS|FLAC|PCM|TRUEHD|MLP)(\/|$)/;

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

const r6 = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6);
const errorOf = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

async function packetsFrom(source: ByteSource, file: Awaited<ReturnType<typeof openMediaFile>>, track: number, from: number) {
  const hash = createHash("sha256");
  let count = 0;
  let first: number | null = null;
  let last: number | null = null;
  for await (const p of audioPacketsFrom(source, file, track, from)) {
    if (p.timestamp >= from + WINDOW) break;
    hash.update(p.data);
    hash.update(`|${r6(p.timestamp)}|`);
    count += 1;
    first ??= p.timestamp;
    last = p.timestamp;
  }
  return { count, first: r6(first), last: r6(last), hash: hash.digest("hex").slice(0, 20) };
}

async function decodedFrom(track: SoftwareAudioTrack, from: number) {
  const hash = createHash("sha256");
  let frames = 0;
  let channels = 0;
  let first: number | null = null;
  let last: number | null = null;
  const t0 = performance.now();
  for await (const d of track.samples(from)) {
    if (d.timestampSeconds >= from + WINDOW) break;
    channels = d.planes.length;
    for (const p of d.planes) hash.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
    hash.update(`|${d.timestampSeconds}|${d.sampleRate}|`);
    frames += d.planes[0]?.length ?? 0;
    first ??= d.timestampSeconds;
    last = d.timestampSeconds;
  }
  return { frames, channels, first: r6(first), last: r6(last), hash: hash.digest("hex").slice(0, 20), ms: Math.round(performance.now() - t0) };
}

it.skipIf(!process.env.AR_TRACKS)(
  "référence du son décodé",
  async () => {
    for (const line of readFileSync(process.env.AR_TRACKS!, "utf8").split("\n").filter(Boolean)) {
      const [path, n, codecId] = line.split("\t");
      const trackNumber = Number(n);
      const row: Record<string, unknown> = { path: path.replace("/mnt/media/video/", ""), track: trackNumber, codec: codecId };
      const source = fileSource(path);
      try {
        const file = await openMediaFile(source);
        const duration = file.durationSeconds ?? 0;
        const points = [0, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0, duration - 60)].map((x) => Math.round(x * 1000) / 1000);
        const packets = [];
        for (const from of points) packets.push({ from, ...(await packetsFrom(source, file, trackNumber, from).catch((e) => ({ error: errorOf(e) }))) });
        row.packets = packets;
        if (NODE_DECODES.test(codecId)) {
          const track = await SoftwareAudioTrack.open(source, trackNumber, codecId, file);
          const decoded = [];
          for (const from of points) decoded.push({ from, ...(await decodedFrom(track, from).catch((e) => ({ error: errorOf(e) }))) });
          row.decoded = decoded;
          track.close();
        }
      } catch (e) {
        row.error = errorOf(e);
      } finally {
        source.close?.();
      }
      appendFileSync(process.env.AR_OUT!, JSON.stringify(row) + "\n");
    }
  },
  6 * 3_600_000
);
