import { describe, it, expect } from "vitest";
import { codecNamesFor, __testing } from "@/lib/webcodecs/ownAudio";
import type { RawFrame } from "@/lib/webcodecs/audioDemux";

// La chaîne du son décodé (ownAudio.ts, DECISIONS.md §197) : le décodeur choisi par codec, et la
// conversion du PCM, la seule qu'elle fasse elle-même.
describe("ownAudio — un décodeur par codec", () => {
  it("nomme chaque codec de la bibliothèque, et rien d'autre", () => {
    expect(codecNamesFor("A_EAC3", null)).toEqual({ name: "eac3", webCodecs: "ec-3" });
    expect(codecNamesFor("A_DTS/EXPRESS", null)?.name).toBe("dts");
    expect(codecNamesFor("A_FLAC", null)?.name).toBe("flac");
    expect(codecNamesFor("A_MPEG/L3", null)?.webCodecs).toBe("mp3");
    expect(codecNamesFor("A_PCM/INT/LIT", null)?.name).toBe("pcm");
    // AAC-LC (objet 2) et HE-AAC (objet 5) se lisent dans l'AudioSpecificConfig.
    expect(codecNamesFor("A_AAC", new Uint8Array([0x11, 0x90]))?.webCodecs).toBe("mp4a.40.2");
    expect(codecNamesFor("A_AAC", new Uint8Array([0x2b, 0x92]))?.webCodecs).toBe("mp4a.40.5");
    // Le TrueHD a son propre chemin (truehd/), le MP2 et la piste QuickTime n'en ont aucun.
    expect(codecNamesFor("A_TRUEHD", null)).toBeNull();
    expect(codecNamesFor("A_MPEG/L2", null)).toBeNull();
    expect(codecNamesFor("A_QUICKTIME", null)).toBeNull();
  });
});

describe("ownAudio — le PCM converti ici, avec l'arithmétique de mediabunny", () => {
  const decode = async (codecId: string, bits: number, bytes: number[]) => {
    const frames: RawFrame[] = [];
    const decoder = await __testing.pcmOpener(codecId, bits, 2, 48000)((f) => frames.push(f));
    await decoder.decode({ data: new Uint8Array(bytes), timestamp: 3.5, duration: 0 });
    return frames;
  };

  it("16 bits signés, petit-boutiste : divisés par 32 768, entrelacés L R → deux plans", async () => {
    // L = +16384 (0.5), R = −32768 (−1) ; puis L = 0, R = +8192 (0.25).
    const [frame] = await decode("A_PCM/INT/LIT", 16, [0x00, 0x40, 0x00, 0x80, 0x00, 0x00, 0x00, 0x20]);
    expect(Array.from(frame.planes[0])).toEqual([0.5, 0]);
    expect(Array.from(frame.planes[1])).toEqual([-1, 0.25]);
    expect(frame.timestamp).toBe(3.5);
  });

  it("24 bits, gros-boutiste ; 8 bits non signés centrés sur 128", async () => {
    const [big] = await decode("A_PCM/INT/BIG", 24, [0x40, 0x00, 0x00, 0xc0, 0x00, 0x00]);
    expect(Array.from(big.planes[0])).toEqual([0.5]);
    expect(Array.from(big.planes[1])).toEqual([-0.5]);
    const [u8] = await decode("A_PCM/INT/LIT", 8, [192, 64]);
    expect(Array.from(u8.planes[0])).toEqual([0.5]);
    expect(Array.from(u8.planes[1])).toEqual([-0.5]);
  });

  it("une profondeur que rien ne décrit est refusée à l'ouverture, pas en pleine lecture", () => {
    expect(() => __testing.pcmOpener("A_PCM/INT/LIT", 12, 2, 48000)).toThrow(/PCM 12 bits/);
  });
});
