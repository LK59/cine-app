import { describe, it, expect } from "vitest";
import {
  measure,
  looksFlattened,
  shapeDistance,
  verdictOf,
  SAME_SHOT_DISTANCE,
  FLATNESS_MARGIN,
} from "@/lib/hdrLook";

const W = 96;
const H = 54;

/**
 * Une image de test : `shade(x, y)` rend une luminance 0–1, appliquée en gris sauf si une
 * saturation est demandée — auquel cas le rouge est laissé et le vert/bleu réduits.
 */
function image(shade: (x: number, y: number) => number, saturation = 0): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.max(0, Math.min(1, shade(x, y)));
      const i = (y * W + x) * 4;
      data[i] = Math.round(v * 255);
      data[i + 1] = Math.round(v * (1 - saturation) * 255);
      data[i + 2] = Math.round(v * (1 - saturation) * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

/** Un plan « normal » : un dégradé qui utilise toute l'échelle, comme une image bien convertie. */
const faithful = (x: number) => x / W;

/**
 * Le même plan aplati : toute l'échelle tassée entre 0,3 et 0,7. C'est ce que fait une courbe PQ
 * envoyée telle quelle — les noirs remontent, les blancs redescendent, la structure ne bouge pas.
 */
const flattened = (x: number) => 0.3 + (x / W) * 0.4;

describe("measure", () => {
  it("reads the black floor and the white ceiling of an image", () => {
    const { look } = measure(image(faithful), W, H);
    expect(look.floor).toBeLessThan(0.25);
    expect(look.ceiling).toBeGreaterThan(0.75);
  });

  it("sees a flattened image as flattened", () => {
    const { look } = measure(image(flattened), W, H);
    expect(look.floor).toBeGreaterThan(0.3);
    expect(look.ceiling).toBeLessThan(0.7);
  });

  // Les bandes noires du format large sont massives et identiques des deux côtés : les compter
  // écraserait le plancher à zéro dans les deux images et effacerait la différence cherchée.
  it("ignores the letterbox bars", () => {
    const bars = (x: number, y: number) => (y < H * 0.14 || y > H * 0.86 ? 0 : flattened(x));
    const { look } = measure(image(bars), W, H);
    expect(look.floor).toBeGreaterThan(0.3);
  });

  it("reads saturation", () => {
    const grey = measure(image(faithful, 0), W, H).look.saturation;
    const colourful = measure(image(faithful, 0.6), W, H).look.saturation;
    expect(grey).toBeLessThan(0.05);
    expect(colourful).toBeGreaterThan(grey + 0.3);
  });
});

describe("shapeDistance", () => {
  // Le cœur de l'appariement : l'aplatissement change les niveaux, pas la composition. Une
  // empreinte centrée-réduite doit donc reconnaître les deux versions du même plan.
  it("recognises the same shot through the flattening", () => {
    const a = measure(image(faithful), W, H).shape;
    const b = measure(image(flattened), W, H).shape;
    expect(shapeDistance(a, b)).toBeLessThan(SAME_SHOT_DISTANCE);
  });

  // Et le cas qui rendrait la comparaison absurde : deux plans différents, dont on ne peut rien
  // conclure sur le rendu. Il faut qu'ils soient rejetés, pas interprétés.
  it("rejects a different shot", () => {
    const a = measure(image((x) => x / W), W, H).shape;
    const b = measure(image((x) => 1 - x / W), W, H).shape;
    expect(shapeDistance(a, b)).toBeGreaterThan(SAME_SHOT_DISTANCE);
  });

  it("rejects a shape it cannot compare", () => {
    expect(shapeDistance([1, 2], [1, 2, 3])).toBe(Infinity);
    expect(shapeDistance([], [])).toBe(Infinity);
  });
});

describe("looksFlattened", () => {
  const reference = measure(image(faithful), W, H).look;

  it("catches the flattened rendering against its correct reference", () => {
    expect(looksFlattened(measure(image(flattened), W, H).look, reference)).toBe(true);
  });

  it("says nothing about an image rendered like its reference", () => {
    expect(looksFlattened(measure(image(faithful), W, H).look, reference)).toBe(false);
  });

  // Les deux conditions, jamais l'une seule : une image simplement plus claire — un écran réglé
  // plus lumineux, une vignette encodée un ton au-dessus — monte son plancher sans baisser son
  // plafond. Ce n'est pas le défaut cherché, et le confondre serait le faux positif classique.
  it("does not mistake a merely brighter image for a flattened one", () => {
    const brighter = measure(image((x) => Math.min(1, faithful(x) + 0.2)), W, H).look;
    expect(looksFlattened(brighter, reference)).toBe(false);
  });

  it("does not mistake a merely darker image for a flattened one", () => {
    const darker = measure(image((x) => faithful(x) * 0.8), W, H).look;
    expect(looksFlattened(darker, reference)).toBe(false);
  });

  // La marge doit rester hors de portée du bruit d'encodage : une vignette JPEG réduite diffère
  // toujours un peu de l'image d'origine, et cette différence-là ne doit jamais conclure.
  it("stays out of reach of encoding noise", () => {
    const noisy = measure(image((x, y) => faithful(x) + ((x + y) % 3) * 0.01), W, H).look;
    expect(looksFlattened(noisy, reference)).toBe(false);
    expect(FLATNESS_MARGIN).toBeGreaterThan(0.05);
  });
});

describe("verdictOf", () => {
  it("waits for enough samples", () => {
    expect(verdictOf([])).toBe("undecided");
    expect(verdictOf([true, true])).toBe("undecided");
  });

  it("concludes only when every sample agrees", () => {
    expect(verdictOf([true, true, true])).toBe("flattened");
    expect(verdictOf([false, false, false])).toBe("faithful");
  });

  // Un désaccord ne se tranche pas à la majorité : c'est le signe d'un contenu ou d'un
  // appariement douteux, et le silence y vaut mieux qu'une bascule.
  it("refuses to decide on a split", () => {
    expect(verdictOf([true, true, false])).toBe("undecided");
    expect(verdictOf([false, false, true])).toBe("undecided");
  });
});
