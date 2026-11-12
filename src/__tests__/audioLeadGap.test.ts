import { describe, it, expect, vi } from "vitest";
import {
  AUDIO_LEAD_GAP_SECONDS,
  audioLeadGapFields,
  audioLeadGapSeconds,
  rememberLeadGap,
  rememberedLeadGap,
  withLeadSilence,
} from "@/lib/webcodecs/audioLeadGap";
import type { DecodedAudio } from "@/lib/webcodecs/softwareAudio";
import type { MatroskaFile } from "@/lib/webcodecs/matroska";

// Le son qui commence après l'image (DECISIONS.md §148) : « The Circle », iPhone, 12/11/2026 — la
// piste AC-3 n'a aucun bloc avant 30 s, et une MediaSource ne joue que l'intersection de ses tampons.

/** Des blocs décodés de 1536 images (une trame AC-3), à partir de `fromSeconds`. */
function blocks(count: number, fromSeconds: number, channels = 6, rate = 48000): DecodedAudio[] {
  return Array.from({ length: count }, (_, i) => ({
    planes: Array.from({ length: channels }, () => new Float32Array(1536).fill(0.25)),
    sampleRate: rate,
    timestampSeconds: fromSeconds + (i * 1536) / rate,
  }));
}

async function* stream(items: DecodedAudio[], onClose?: () => void): AsyncGenerator<DecodedAudio> {
  try {
    for (const item of items) yield item;
  } finally {
    onClose?.();
  }
}

async function all(generator: AsyncGenerator<DecodedAudio>): Promise<DecodedAudio[]> {
  const out: DecodedAudio[] = [];
  for await (const item of generator) out.push(item);
  return out;
}

describe("la décision : le son commence-t-il après l'image ?", () => {
  it("non sous le seuil, ni au seuil — un fichier ordinaire ne change pas", () => {
    expect(audioLeadGapSeconds(0, 0)).toBeNull();
    // La VO de « Green Book » : 20 ms après l'image.
    expect(audioLeadGapSeconds(0, 0.02)).toBeNull();
    // Un décalage de réordonnancement, une trame : très en dessous.
    expect(audioLeadGapSeconds(10, 10.25)).toBeNull();
    expect(audioLeadGapSeconds(0, AUDIO_LEAD_GAP_SECONDS)).toBeNull();
  });

  it("non quand le son arrive avant l'image (le bloc audio rangé devant l'image clé)", () => {
    expect(audioLeadGapSeconds(120, 119.97)).toBeNull();
    expect(audioLeadGapSeconds(0, -0.005)).toBeNull();
  });

  it("oui au-delà : l'écart depuis le premier instant de l'image", () => {
    expect(audioLeadGapSeconds(0, 30)).toBe(30);
    expect(audioLeadGapSeconds(8.5, 30)).toBeCloseTo(21.5, 9);
    expect(audioLeadGapSeconds(0, AUDIO_LEAD_GAP_SECONDS + 0.01)).toBeCloseTo(AUDIO_LEAD_GAP_SECONDS + 0.01, 9);
  });
});

describe("le silence devant le premier son", () => {
  it("sans trou, le flux du décodeur passe tel quel — les mêmes objets, dans le même ordre", async () => {
    const source = blocks(5, 119.9);
    const onGap = vi.fn();
    const out = await all(withLeadSilence(stream(source), 120, onGap));
    expect(out).toHaveLength(5);
    out.forEach((item, i) => expect(item).toBe(source[i]));
    expect(onGap).not.toHaveBeenCalled();
  });

  it("comble exactement l'écart : durée au nombre d'images près, canaux et fréquence du premier bloc, zéros", async () => {
    // Un saut à 10 s dans « The Circle » : le premier son est à 30 s.
    const source = blocks(3, 30, 6, 48000);
    const onGap = vi.fn();
    const out = await all(withLeadSilence(stream(source), 10, onGap));
    expect(onGap).toHaveBeenCalledWith(20);

    const silent = out.slice(0, out.length - 3);
    const frames = silent.reduce((n, b) => n + b.planes[0].length, 0);
    expect(frames).toBe(20 * 48000);
    // Contigus : chaque bloc commence où le précédent finit, le premier à l'instant demandé.
    let at = 10;
    for (const b of silent) {
      expect(b.timestampSeconds).toBeCloseTo(at, 9);
      expect(b.sampleRate).toBe(48000);
      expect(b.planes).toHaveLength(6);
      for (const plane of b.planes) expect(plane.every((v) => v === 0)).toBe(true);
      at += b.planes[0].length / 48000;
    }
    // Et la fin du silence tombe sur le premier vrai bloc, qui suit tel quel.
    expect(at).toBeCloseTo(30, 9);
    expect(out.slice(-3)).toEqual(source);
    expect(out[out.length - 3]).toBe(source[0]);
  });

  it("arrondit une seule fois, sur le total : jamais plus d'un demi-échantillon d'écart à la fin", async () => {
    // 44,1 kHz, un écart qui ne tombe pas sur un échantillon entier.
    const first = 12.3456789;
    const source = blocks(1, first, 2, 44100);
    const out = await all(withLeadSilence(stream(source), 0.1, () => {}));
    const silent = out.slice(0, -1);
    const frames = silent.reduce((n, b) => n + b.planes[0].length, 0);
    expect(frames).toBe(Math.round((first - 0.1) * 44100));
    expect(Math.abs(0.1 + frames / 44100 - first)).toBeLessThanOrEqual(0.5 / 44100);
    expect(silent.every((b) => b.planes.length === 2 && b.sampleRate === 44100)).toBe(true);
  });

  it("produit le silence au fil de la demande, pas trente secondes d'un coup", async () => {
    const generator = withLeadSilence(stream(blocks(1, 30)), 0);
    const first = await generator.next();
    expect(first.done).toBe(false);
    expect(first.value!.planes[0].length).toBeLessThanOrEqual(4096);
    await generator.return(undefined);
  });

  it("un saut pendant le silence ferme aussi le flux du décodeur, suspendu derrière", async () => {
    const closed = vi.fn();
    const generator = withLeadSilence(stream(blocks(4, 30), closed), 0);
    await generator.next();
    await generator.next();
    await generator.return(undefined);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("un décodeur qui ne rend rien ne rend rien", async () => {
    expect(await all(withLeadSilence(stream([]), 0))).toEqual([]);
  });
});

describe("la mémoire de la page et la ligne `start`", () => {
  it("retient une piste en retard par fichier et par numéro, et rien d'autre", () => {
    const file = { tracks: [] } as unknown as MatroskaFile;
    const other = { tracks: [] } as unknown as MatroskaFile;
    expect(rememberedLeadGap(file, 2)).toBeUndefined();
    rememberLeadGap(file, 2, 24.02);
    expect(rememberedLeadGap(file, 2)).toBe(24.02);
    // Revu depuis une image clé plus loin dans le trou : le plus grand reste.
    rememberLeadGap(file, 2, 22.18);
    expect(rememberedLeadGap(file, 2)).toBe(24.02);
    expect(rememberedLeadGap(file, 3)).toBeUndefined();
    expect(rememberedLeadGap(other, 2)).toBeUndefined();
  });

  it("n'écrit rien pour un fichier ordinaire, l'écart arrondi et l'issue pour un fichier à trou", () => {
    expect(audioLeadGapFields(null)).toEqual({});
    expect(audioLeadGapFields(undefined)).toEqual({});
    expect(audioLeadGapFields({ gapS: 30.0, action: "silence" })).toEqual({ audioLeadGapS: 30, audioGap: "silence" });
    expect(audioLeadGapFields({ gapS: 11.795, action: "enjambé" })).toEqual({ audioLeadGapS: 11.8, audioGap: "enjambé" });
  });
});
