import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { MemoryByteSource } from "@/lib/webcodecs/byteSource";
import { openMediaFile, createSampleReader } from "@/lib/webcodecs/mediaFile";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";

// Le son qu'un navigateur ne prend pas (l'AC-3 et l'E-AC3 sur Chrome et Firefox) est décodé ici
// par mediabunny, qui lit le conteneur lui-même. Pour un MP4, il doit le lire *comme un MP4* — lu
// comme un Matroska, il ne trouvait aucune piste, et le film restait muet — et nommer ses pistes
// comme nous, sans quoi la piste choisie au menu ne serait pas celle décodée. Et ses instants
// doivent tomber sur les nôtres : c'est eux qui calent le son ré-encodé sur l'image copiée.

const DIR = "src/__tests__/fixtures/mp4";

describe("décodage logiciel d'un son de MP4", () => {
  it("ouvre la piste AC-3 demandée, au même instant que notre lecture", async () => {
    const source = new MemoryByteSource(new Uint8Array(readFileSync(`${DIR}/c-hevc-multi.mp4`)));
    const file = await openMediaFile(source);
    const track = file.tracks.find((t) => t.codecId === "A_AC3")!;
    expect(track.number).toBe(3);

    const software = await SoftwareAudioTrack.open(source, track.number, track.codecId, file);
    expect(software.format).toEqual({ sampleRate: 48000, numberOfChannels: 1 });

    // Le premier bloc décodé commence là où notre lecteur place la première trame AC-3.
    const reader = createSampleReader(source, file, file.firstClusterOffset!);
    let first: number | null = null;
    for (let s = await reader.next(); s && first === null; s = await reader.next()) {
      if (s.trackNumber === track.number) first = s.timestampUs;
    }
    const decoded = software.samples(0);
    const block = (await decoded.next()).value!;
    await decoded.return(undefined);
    expect(Math.round(block.timestampSeconds * 1e6)).toBe(first);
    // Et c'est du son, pas une piste voisine : un sinus de 660 Hz a de l'énergie.
    expect(Math.max(...block.planes[0].map(Math.abs))).toBeGreaterThan(0.05);
    software.close();
  });
});
