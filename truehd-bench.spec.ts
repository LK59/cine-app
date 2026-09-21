// Banc du TrueHD, sur les vrais fichiers de la bibliothèque — sauté sans fichier.
//
// Passe par toute la chaîne que le lecteur emprunte (SoftwareAudioTrack → lecteur Matroska →
// décodeur TrueHD → découpage dans le temps), puis imprime le niveau de chaque canal sur dix
// secondes, à comparer à ffmpeg sur les mêmes secondes :
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e THD_FILE="/media/movies/Top Gun - Maverick (2022)/Top Gun - Maverick (2022).mkv" \
//     -e THD_FROM=600 node:24-alpine npx vitest run truehd-bench.spec.ts
//   ffmpeg -ss 600 -t 10 -i "…mkv" -map 0:a:0 \
//     -af astats=measure_overall=none:measure_perchannel=RMS_level -f null -
//
// Mesuré le 21/09/2026 : identique à ffmpeg à 0,01 dB près sur les 8 canaux de Top Gun Maverick
// (début, 10:00, 50:01, 1:10:00), Gattaca 5.1, American Sniper VF et Braveheart ; au plus 88 ms
// sans son après un saut ; 58 à 89 fois le temps réel.
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

it.skipIf(!process.env.THD_FILE)("TrueHD, d'un bout à l'autre de la chaîne", { timeout: 600_000 }, async () => {
  const from = Number(process.env.THD_FROM ?? 600);
  const span = 10;
  const source = fileSource(process.env.THD_FILE!);
  const file = await parseMatroska(source);
  const track = file.tracks.find((t) => t.codecId === "A_TRUEHD" || t.codecId === "A_MLP")!;
  const began = performance.now();
  const audio = await SoftwareAudioTrack.open(source, track.number, track.codecId);
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
      piste: `${track.codecId} ${track.language ?? "?"}`,
      format: audio.format,
      premierInstant: first,
      trous: gaps,
      secondes: frames / rate,
      crete: +peak.toFixed(4),
      rmsDb: sums.map((sum) => +(10 * Math.log10(sum / frames)).toFixed(2)),
      tempsMs: Math.round(ms),
    })
  );
});
