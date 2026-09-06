import { describe, it, expect } from "vitest";
import { flacBitsPerSample, audioSampleEntryFor } from "@/lib/webcodecs/mp4SampleEntries";

/**
 * Construit un STREAMINFO réel : c'est un champ de bits, et c'est ce qui rendait la faute
 * invisible à la lecture. Les cinq bits de profondeur sont à cheval sur deux octets.
 */
function streamInfo(bitsPerSample: number, channels = 1, sampleRate = 48000): Uint8Array {
  const info = new Uint8Array(34);
  // 16 b bloc min, 16 b bloc max, 24 b trame min, 24 b trame max — sans importance ici.
  info[0] = 0x10; info[2] = 0x10;
  // Vingt bits de fréquence à partir du bit 80 (octet 10), trois de canaux, cinq de profondeur —
  // tous stockés diminués de un. Écrits bit à bit plutôt qu'en BigInt : le dépôt cible ES2019.
  const write = (bitOffset: number, width: number, value: number) => {
    for (let i = 0; i < width; i++) {
      const bit = (value >>> (width - 1 - i)) & 1;
      const at = bitOffset + i;
      if (bit) info[at >> 3] |= 0x80 >> (at & 7);
    }
  };
  write(80, 20, sampleRate);
  write(100, 3, channels - 1);
  write(103, 5, bitsPerSample - 1);
  return info;
}

/** Le bloc tel que Matroska le garde : la magie `fLaC`, un en-tête de bloc, puis STREAMINFO. */
function codecPrivate(bitsPerSample: number): Uint8Array {
  const info = streamInfo(bitsPerSample);
  const out = new Uint8Array(4 + 4 + info.length);
  out.set([0x66, 0x4c, 0x61, 0x43], 0); // « fLaC »
  out[4] = 0x80; // dernier bloc, type 0 = STREAMINFO
  out[5] = 0; out[6] = 0; out[7] = 34;
  out.set(info, 8);
  return out;
}

/**
 * Le champ `samplesize` de l'AudioSampleEntry.
 *
 * Dans le corps de la boîte : six octets réservés, deux d'index de référence, huit réservés, deux
 * de nombre de canaux — puis les deux qui nous intéressent, au dix-huitième.
 */
function declaredSampleSize(entry: Uint8Array): number {
  const body = entry.subarray(8); // passé la taille et le type de la boîte
  return (body[18] << 8) | body[19];
}

describe("flacBitsPerSample", () => {
  it.each([8, 16, 20, 24, 32])("relit %i bits depuis STREAMINFO", (depth) => {
    expect(flacBitsPerSample(codecPrivate(depth))).toBe(depth);
  });

  it("accepte aussi un bloc sans la magie, comme certains fichiers le stockent", () => {
    const withMagic = codecPrivate(24);
    expect(flacBitsPerSample(withMagic.subarray(4))).toBe(24);
  });

  it("rend null sur des octets qui ne décrivent pas un flux", () => {
    expect(flacBitsPerSample(new Uint8Array(4))).toBeNull();
  });
});

describe("l'entrée d'échantillon FLAC", () => {
  /**
   * Le défaut d'origine, et il coûtait la lecture entière.
   *
   * Chrome compare ce champ au STREAMINFO du `dfLa` d'à côté et refuse tout le segment
   * d'initialisation s'ils diffèrent — « FLAC AudioSampleEntry sample size mismatches
   * FLACSpecificBox STREAMINFO sample size ». La MediaSource meurt avant la première image.
   * Safari ne vérifie pas : le même fichier se lisait sur iPhone et pas sur Android.
   */
  it.each([16, 24])("déclare la profondeur du fichier (%i bits), pas seize par défaut", (depth) => {
    const entry = audioSampleEntryFor({
      codecId: "A_FLAC",
      codecPrivate: codecPrivate(depth),
      channels: 1,
      sampleRate: 48000,
      firstFrame: null,
    });
    expect(declaredSampleSize(entry)).toBe(depth);
  });

  it("laisse les autres codecs sur seize, où ce champ n'est lu par personne", () => {
    const entry = audioSampleEntryFor({
      codecId: "A_AAC",
      codecPrivate: new Uint8Array([0x11, 0xb0]),
      channels: 2,
      sampleRate: 48000,
      firstFrame: null,
    });
    expect(declaredSampleSize(entry)).toBe(16);
  });
});
