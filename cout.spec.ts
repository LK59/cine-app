// Où va le temps quand on lance un film, et quand on y saute — mesuré sur un vrai fichier.
//
// Compagnon de `bench.spec.ts`, qui vérifie ce que le remultiplexeur *produit* ; celui-ci mesure
// ce qu'il *coûte*. Écrit le 20/09/2026 pour répondre à « peut-on aller plus vite ? » autrement
// que par une intuition, et gardé parce que la réponse se démode : elle tient à la taille des
// fichiers et à la version des bibliothèques, pas au code de ce dépôt.
//
// Ce qu'il a établi ce jour-là, sur cette bibliothèque :
//
//   4K (8,3 Go, 13 pistes)  en-tête 77 ms / 0,2 Mo  |  avant la 1re image 4,2 Mo  |  saut 4,4 Mo
//   HD (2,3 Go,  7 pistes)  en-tête 79 ms / 0,2 Mo  |  avant la 1re image 2,0 Mo  |  saut 1,4 Mo
//
// Le rapport 2,1× entre les deux se retrouve dans les ouvertures réelles relevées par
// `data/logs/player.log` — 4K 1 250 à 1 600 ms, HD 565 à 690 ms. Donc **le lancement est borné
// par les octets, pas par le calcul** : le processeur totalise une centaine de millisecondes.
// Et ces octets sont ceux de l'entrelacement du fichier lui-même — produire 29 Ko de vidéo
// demande d'en traverser 2,8 Mo, parce que les treize pistes y sont tressées ensemble.
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e COUT_FILE="/media/movies/…mkv" node:24-alpine npx vitest run cout.spec.ts
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { describe, it } from "vitest";
import { parseMatroska } from "@/lib/webcodecs/matroska";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

const compteur = { lectures: 0, octets: 0, ms: 0 };
function source(path: string): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    read: async (start: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - start));
      const buffer = Buffer.alloc(length);
      const t = performance.now();
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      compteur.ms += performance.now() - t;
      compteur.lectures += 1;
      compteur.octets += read;
      return new Uint8Array(buffer.subarray(0, read));
    },
    close: () => closeSync(fd),
  };
}

const remise = () => { compteur.lectures = 0; compteur.octets = 0; compteur.ms = 0; };
const bilan = (quoi: string, ms: number) =>
  console.log(
    `${quoi.padEnd(34)} ${ms.toFixed(0).padStart(5)} ms  |  ${String(compteur.lectures).padStart(4)} lectures, ` +
    `${(compteur.octets / 1024 / 1024).toFixed(1).padStart(6)} Mo lus (${compteur.ms.toFixed(0)} ms de disque)`
  );

describe.skipIf(!process.env.COUT_FILE)("coût", () => {
  it("ouverture et saut", { timeout: 600_000 }, async () => {
    // Livraison par piste (le défaut) : pas d'unification, donc pas d'encodeur à réclamer ici —
    // passée explicitement à `Remuxer.open` plus bas.
    const src = source(process.env.COUT_FILE!);
    console.log(`fichier : ${(src.size / 1024 / 1024 / 1024).toFixed(2)} Go`);

    remise();
    let t = performance.now();
    const file = await parseMatroska(src);
    bilan("lecture de l'en-tête", performance.now() - t);

    const video = file.tracks.find((k) => k.type === "video")!;
    const audio = file.tracks.filter((k) => k.type === "audio")[0] ?? null;
    console.log(`  vidéo ${video.codecId}, audio ${audio?.codecId ?? "aucune"}, ${file.tracks.length} pistes`);

    remise();
    t = performance.now();
    const remuxer = await Remuxer.open(
      src, file, video, audio,
      { width: video.video?.width ?? 1920, height: video.video?.height ?? 1080 },
      null, 0, { perTrack: true }
    );
    bilan("ouverture du remultiplexeur", performance.now() - t);

    remise();
    t = performance.now();
    await remuxer.nextSegment();
    bilan("premier segment (depuis le début)", performance.now() - t);

    for (const seconde of [600, 3600, 6000]) {
      remise();
      t = performance.now();
      remuxer.seekTo(seconde);
      await remuxer.nextSegment();
      bilan(`saut à ${seconde} s puis un segment`, performance.now() - t);
    }

    remise();
    t = performance.now();
    for (let i = 0; i < 10; i++) await remuxer.nextSegment();
    bilan("10 segments d'affilée (~25 s)", performance.now() - t);
  });
});
