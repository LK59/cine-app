import { describe, it, expect } from "vitest";
import { CustomSource, EncodedPacketSink, Input, MatroskaInputFormat } from "mediabunny";
import { bigMatroska } from "./helpers/bigMatroska";

/**
 * Un saut au-delà de la dernière trame d'une piste audio ne relit pas tout le fichier.
 *
 * Le son que le navigateur refuse (AC-3, E-AC-3, DTS, FLAC, Opus) est démultiplexé par mediabunny à
 * travers la source HTTP du lecteur (`softwareAudio.ts`) : chaque octet qu'il lit traverse le réseau.
 * Un doublage plus court que le générique laisse une queue sans cette piste, et l'index de mkvmerge
 * ne porte que sur la vidéo. mediabunny 1.62.0 y prenait chaque point d'index pour un menteur et,
 * au second, repartait du début du fichier : 18,9 Go lus pour un saut dans le générique d'un film de
 * la bibliothèque, 12,9 Go pour un autre dont la VF finit 5 s avant l'image (banc du 21/10/2026),
 * contre 573 Mo et 3,5 Mo en 1.61.4. Ce test échoue sur 1.62.0 (100 % du fichier lu) et passe sur
 * 1.61.4 (10 %) : une montée de mediabunny ne passe pas tant que la queue reste bornée.
 */

const SECONDS = 300;
const AUDIO_UNTIL = 270;

function measured(file: Uint8Array) {
  const count = { bytes: 0 };
  const input = new Input({
    formats: [new MatroskaInputFormat()],
    source: new CustomSource({
      getSize: () => file.length,
      read: (start, end) => {
        count.bytes += end - start;
        return file.subarray(start, Math.min(end, file.length));
      },
    }),
  });
  return { input, count };
}

describe("mediabunny, une piste audio qui finit avant le fichier", () => {
  const file = bigMatroska(SECONDS, 100_000, AUDIO_UNTIL);

  it("un saut dans la queue sans son rend la dernière trame en lisant une part bornée du fichier", async () => {
    const { input, count } = measured(file);
    const [track] = await input.getAudioTracks();
    count.bytes = 0;
    const packet = await new EncodedPacketSink(track).getPacket(AUDIO_UNTIL + 10);
    expect(packet?.timestamp).toBe(AUDIO_UNTIL - 1);
    expect(count.bytes / file.length).toBeLessThan(0.25);
  });

  it("la dernière trame (durée de la piste) aussi", async () => {
    const { input, count } = measured(file);
    const [track] = await input.getAudioTracks();
    count.bytes = 0;
    const packet = await new EncodedPacketSink(track).getPacket(Infinity);
    expect(packet?.timestamp).toBe(AUDIO_UNTIL - 1);
    expect(count.bytes / file.length).toBeLessThan(0.25);
  });
});
