// Une piste audio plus courte que l'image : ce que le remplissage doit lire pour atteindre la fin du fichier.
//
// MediaSource ne joue que l'intersection des deux tampons tant que le flux n'est pas déclaré fini
// (`endOfStream`). Quand la piste audio choisie s'arrête avant l'image, la lecture s'arrête donc à la fin du son, et
// ne repart qu'une fois toute la vidéo restante envoyée et le flux déclaré fini. Ce banc dit, sur un vrai fichier,
// combien d'octets de vidéo séparent la fin du son de la fin du fichier — à comparer aux plafonds des tampons
// (WebKit 105 Mo sur iPhone et iPad, Chromium 150 Mio : `bufferBudget.ts`). Écrit le 18/11/2026 (chasse de nuit).
//
// Relevé ce jour-là sur les pistes de la bibliothèque qui finissent le plus tôt (VF finie 74 à 114 s avant l'image) :
// la queue n'est qu'un générique sombre — *Vaiana* 4K 21,7 Mo, *Le Diable s'habille en Prada 2* 1,9 Mo,
// *Wingwomen* 2,0 Mo, *Dexter* S06E01 6,5 Mo. Le remplissage, que rien ne borne en octets passé la fin du son, atteint
// donc la fin du fichier bien avant les plafonds, et `endOfStream` rend la lecture. À relancer si une piste finit
// avant une vraie scène.
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e QSS_FILE="/media/movies/…mkv" -e QSS_AUDIO=0 -e QSS_FROM=6800 node:26-alpine npx vitest run queue-sans-son-bench.spec.ts
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { describe, it } from "vitest";
import { parseMatroska } from "@/lib/webcodecs/matroska";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

let readBytes = 0;
function source(path: string): ByteSource {
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
      readBytes += read;
      return new Uint8Array(buffer.subarray(0, read));
    },
    close: () => closeSync(fd),
  };
}

const MB = 1024 * 1024;

describe.skipIf(!process.env.QSS_FILE)("queue sans son", () => {
  it("mesure", { timeout: 600_000 }, async () => {
    const src = source(process.env.QSS_FILE!);
    const file = await parseMatroska(src);
    const video = file.tracks.find((t) => t.type === "video")!;
    // La n-ième piste audio du fichier (0 : la première), dans l'ordre de `ffprobe`.
    const audio = file.tracks.filter((t) => t.type === "audio")[Number(process.env.QSS_AUDIO ?? 0)] ?? null;
    console.log(`vidéo ${video.codecId}, audio ${audio ? `${audio.number} ${audio.codecId} ${audio.language}` : "aucune"}, durée ${file.durationSeconds?.toFixed(0)} s`);
    const remuxer = await Remuxer.open(src, file, video, audio, { width: video.video?.width ?? 1920, height: video.video?.height ?? 1080 }, null, 0, { perTrack: true });
    remuxer.seekTo(Number(process.env.QSS_FROM ?? 0));
    let lastAudioEnd: number | null = null;
    let videoAfter = 0;
    let segmentsAfter = 0;
    let end = 0;
    const t = performance.now();
    readBytes = 0;
    for (;;) {
      const segment = await remuxer.nextSegment();
      if (!segment) break;
      const v = segment.video.reduce((n, f) => n + f.byteLength, 0);
      if (segment.audio && segment.audio.byteLength > 0) {
        lastAudioEnd = segment.endSeconds;
        videoAfter = 0;
        segmentsAfter = 0;
      } else {
        videoAfter += v;
        segmentsAfter += 1;
      }
      end = segment.endSeconds;
    }
    console.log(`dernier segment avec du son : jusqu'à ${lastAudioEnd?.toFixed(1)} s ; fin du fichier ${end.toFixed(1)} s`);
    console.log(`après la fin du son : ${segmentsAfter} segments, ${(videoAfter / MB).toFixed(1)} Mo de vidéo à envoyer avant la fin du flux`);
    console.log(`lu depuis le départ : ${(readBytes / MB).toFixed(1)} Mo en ${(performance.now() - t).toFixed(0)} ms`);
  });
});
