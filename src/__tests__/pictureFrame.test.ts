import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jellyfin", apiKey: "k" }, player: { enabled: true, autoFrame: true } } }));
vi.mock("@/lib/server-cache", () => ({ withPersistentCache: (_k: string, _t: number, fn: () => unknown) => fn() }));

import { contentBounds, unionFrame } from "@/lib/pictureFrame";

const W = 320;
const H = 180;

/** Une vignette : noir partout, image grise entre les lignes et colonnes données. */
function thumb(top: number, bottom: number, left = 0, right = W, level = 120): Uint8Array {
  const gray = new Uint8Array(W * H);
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) gray[y * W + x] = level;
  return gray;
}

describe("contentBounds", () => {
  // The Kissing Booth : 1920×1080 dont 1920×872 d'image, soit 17,3 lignes de bande sur 180.
  it("finds bars baked into the frame", () => {
    expect(contentBounds(thumb(17, 163), W, 0, 0, W, H)).toEqual({ top: 17, bottom: 163, left: 0, right: W });
  });

  it("finds bars on the sides without counting the top and bottom ones", () => {
    expect(contentBounds(thumb(20, 160, 40, 280), W, 0, 0, W, H)).toEqual({ top: 20, bottom: 160, left: 40, right: 280 });
  });

  it("says nothing of a black picture", () => {
    expect(contentBounds(new Uint8Array(W * H), W, 0, 0, W, H)).toBeNull();
  });

  // Les vignettes sont collées dans une planche JPEG, et les blocs de 8×8 débordent de l'une sur
  // l'autre : une ou deux lignes éclairées au bord ne sont pas une image.
  it("reads content starting in the edge margin as starting at the edge", () => {
    expect(contentBounds(thumb(1, 179), W, 0, 0, W, H)).toMatchObject({ top: 0, bottom: H });
  });

  it("reads one thumbnail out of a sheet", () => {
    const sheet = new Uint8Array(W * 2 * H);
    const one = thumb(30, 150);
    for (let y = 0; y < H; y++) sheet.set(one.subarray(y * W, (y + 1) * W), y * W * 2 + W);
    expect(contentBounds(sheet, W * 2, W, 0, W, H)).toMatchObject({ top: 30, bottom: 150 });
    expect(contentBounds(sheet, W * 2, 0, 0, W, H)).toBeNull();
  });
});

describe("unionFrame", () => {
  const letterboxed = (n: number) => Array.from({ length: n }, () => ({ top: 17, bottom: 163, left: 0, right: W }));

  it("keeps a pixel of margin, towards less bar", () => {
    const frame = unionFrame(letterboxed(40), W, H)!;
    expect(frame.top).toBeCloseTo(16 / H, 4);
    expect(frame.bottom).toBeCloseTo(164 / H, 4);
    expect(frame).toMatchObject({ left: 0, right: 1, samples: 40 });
  });

  // La propriété qui rend la mesure sûre : une seule vignette où l'image touche le bord suffit à
  // annuler la bande — Sinners et ses séquences IMAX, ou Gravity et son espace noir.
  it("gives the whole frame back as soon as one thumbnail fills it", () => {
    const frame = unionFrame([...letterboxed(60), { top: 0, bottom: H, left: 0, right: W }], W, H)!;
    expect(frame).toMatchObject({ top: 0, bottom: 1, left: 0, right: 1 });
  });

  it("a dark scene narrows only itself", () => {
    const frame = unionFrame([...letterboxed(40), { top: 60, bottom: 120, left: 100, right: 200 }], W, H)!;
    expect(frame.top).toBeCloseTo(16 / H, 4);
    expect(frame).toMatchObject({ left: 0, right: 1 });
  });

  // Moins de 1 % par côté, marge ôtée, n'est pas une bande. Love Story (1,85 dans du 16:9, deux
  // lignes de plus) passe juste au-dessus, et c'est voulu : ses bandes sont réelles.
  it("ignores a hairline", () => {
    const frame = unionFrame(Array.from({ length: 40 }, () => ({ top: 2, bottom: H - 2, left: 0, right: W })), W, H)!;
    expect(frame).toMatchObject({ top: 0, bottom: 1 });
  });

  it("does not guess from too few thumbnails", () => {
    expect(unionFrame(letterboxed(10), W, H)).toBeNull();
  });
});
