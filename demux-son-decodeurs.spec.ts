// Banc de l'essai demux-son, 2e partie (19/11/2026) — sauté sans DS_TRACKS.
//
// Pour chaque piste AC-3 / E-AC3 / DTS : le son décodé par le chemin actuel (mediabunny lit et
// décode) contre l'essai complet (notre lecteur lit, NOTRE FFmpeg 7.1.5 décode — tools/ac3dts-wasm).
// Deux décodeurs FFmpeg de versions différentes : une identité à l'octet n'est pas attendue d'office.
// Ce qui est mesuré, par instant de départ : identité, nombre d'images et instants, écart maximal
// d'échantillon, et le niveau RMS de chaque canal des deux côtés (dB) — la méthode qui a tranché
// l'ordre des canaux et le TrueHD (CLAUDE.md, « measure, don't reason »).
import { it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync, appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

const WINDOW = Number(process.env.DS_SECONDS ?? 30);
const CODECS = new Set(["A_AC3", "A_EAC3", "A_DTS"]);

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

async function capture(track: SoftwareAudioTrack, from: number) {
  const planes: number[][] = [];
  const times: number[] = [];
  const t0 = performance.now();
  for await (const d of track.samples(from)) {
    if (d.timestampSeconds >= from + WINDOW) break;
    times.push(d.timestampSeconds);
    d.planes.forEach((p, c) => {
      planes[c] ??= [];
      for (let i = 0; i < p.length; i++) planes[c].push(p[i]);
    });
  }
  return { planes, times, ms: Math.round(performance.now() - t0) };
}

const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 100) / 100 : -999);

it.skipIf(!process.env.DS_TRACKS)(
  "demux-son : nos décodeurs AC-3/E-AC3/DTS contre ceux de mediabunny",
  async () => {
    const lines = readFileSync(process.env.DS_TRACKS!, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const [path, n, codecId] = line.split("\t");
      if (!CODECS.has(codecId)) continue;
      const trackNumber = Number(n);
      const row: Record<string, unknown> = { path: path.replace("/mnt/media/video/", ""), track: trackNumber, codec: codecId };
      const source = fileSource(path);
      try {
        const file = await openMediaFile(source);
        const duration = file.durationSeconds ?? 0;
        const points = [0, duration * 0.25, duration * 0.5, duration * 0.75].map((x) => Math.round(x * 1000) / 1000);
        const a = await SoftwareAudioTrack.open(source, trackNumber, codecId, file);
        const b = await SoftwareAudioTrack.open(source, trackNumber, codecId, file, { demux: "nôtre", decoders: "nôtres" });
        const results = [];
        for (const from of points) {
          const ca = await capture(a, from);
          const cb = await capture(b, from);
          const channels = Math.max(ca.planes.length, cb.planes.length);
          let maxDiff = 0;
          const levels = [];
          for (let c = 0; c < channels; c++) {
            const pa = ca.planes[c] ?? [];
            const pb = cb.planes[c] ?? [];
            const len = Math.min(pa.length, pb.length);
            let sa = 0;
            let sb = 0;
            for (let i = 0; i < len; i++) {
              maxDiff = Math.max(maxDiff, Math.abs(pa[i] - pb[i]));
              sa += pa[i] * pa[i];
              sb += pb[i] * pb[i];
            }
            levels.push([db(Math.sqrt(sa / Math.max(1, len))), db(Math.sqrt(sb / Math.max(1, len)))]);
          }
          results.push({
            from,
            framesA: ca.planes[0]?.length ?? 0,
            framesB: cb.planes[0]?.length ?? 0,
            chA: ca.planes.length,
            chB: cb.planes.length,
            sameTimes: JSON.stringify(ca.times) === JSON.stringify(cb.times),
            firstA: ca.times[0] ?? null,
            firstB: cb.times[0] ?? null,
            maxDiff,
            levels,
            msA: ca.ms,
            msB: cb.ms,
          });
        }
        row.results = results;
        a.close();
        b.close();
      } catch (e) {
        row.error = String(e instanceof Error ? e.message : e).slice(0, 200);
      } finally {
        source.close?.();
      }
      appendFileSync(process.env.DS_OUT!, JSON.stringify(row) + "\n");
    }
  },
  6 * 3_600_000
);
