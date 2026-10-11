// Banc du décodeur AAC de FFmpeg en WebAssembly (aac/aacWasmAudio.ts), sur un vrai fichier à PCE —
// sauté sans fichier. Le jumeau de truehd-bench.spec.ts.
//
// Passe par la chaîne que le lecteur emprunte hors Chromium pour un AAC à PCE dont la copie est
// refusée (SoftwareAudioTrack → lecteur Matroska → décodeur WebAssembly → rangement des canaux),
// puis imprime le niveau de chaque canal livré, à comparer à ffmpeg sur les mêmes secondes :
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e AAC_FILE="/media/movies/Ruby Sparks (2012)/Ruby Sparks (2012).mkv" -e AAC_FROM=600 \
//     node:24-alpine npx vitest run aac-wasm-bench.spec.ts
//   ffmpeg -ss 600 -t 10 -i "…mkv" -map 0:a:0 \
//     -af astats=measure_overall=none:measure_perchannel=RMS_level -f null -
//
// Mesuré le 11/10/2026 sur « Elle s'appelle Ruby » : voir DOC-TECH.md « Audio delivery ».
import { it } from "vitest";
import { openSync, readSync, statSync, closeSync } from "node:fs";
import { parseMatroska } from "@/lib/webcodecs/matroska";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

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

it.skipIf(!process.env.AAC_FILE)("AAC à PCE, décodé par FFmpeg en WebAssembly", { timeout: 600_000 }, async () => {
  const from = Number(process.env.AAC_FROM ?? 600);
  const span = Number(process.env.AAC_SPAN ?? 10);
  const source = fileSource(process.env.AAC_FILE!);
  const file = await parseMatroska(source);
  const index = Number(process.env.AAC_TRACK_INDEX ?? 0);
  const track = file.tracks.filter((t) => t.codecId === "A_AAC")[index]!;
  const began = performance.now();
  // Sans navigateur, la route est celle de tout moteur hors Chromium : le décodeur WebAssembly.
  const audio = await SoftwareAudioTrack.open(source, track.number, track.codecId, file);
  const openedMs = Math.round(performance.now() - began);
  const sums: number[] = [];
  let frames = 0;
  let peak = 0;
  let first: number | null = null;
  let expected: number | null = null;
  let gaps = 0;
  for await (const chunk of audio.samples(from)) {
    first ??= chunk.timestampSeconds;
    if (expected !== null && Math.abs(chunk.timestampSeconds - expected) > 0.002) gaps++;
    expected = chunk.timestampSeconds + chunk.planes[0].length / chunk.sampleRate;
    for (let i = 0; i < chunk.planes[0].length; i++) {
      const t = chunk.timestampSeconds + i / chunk.sampleRate;
      if (t < from || t >= from + span) continue;
      chunk.planes.forEach((plane, c) => {
        sums[c] = (sums[c] ?? 0) + plane[i] * plane[i];
        peak = Math.max(peak, Math.abs(plane[i]));
      });
      frames++;
    }
    if (chunk.timestampSeconds >= from + span) break;
  }
  const ms = performance.now() - began;
  audio.close();
  source.close();
  const rate = audio.format.sampleRate;
  console.log(
    JSON.stringify({
      piste: `${track.codecId} ${track.language ?? "?"} ${track.audio?.channels ?? "?"} canaux`,
      format: audio.format,
      premierInstant: first,
      trous: gaps,
      secondes: frames / rate,
      crete: +peak.toFixed(4),
      rmsDb: sums.map((sum) => +(10 * Math.log10(sum / frames)).toFixed(2)),
      ouvertureMs: openedMs,
      tempsMs: Math.round(ms),
    })
  );
});
