// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  cueCss,
  overlayCss,
  subtitleFontPx,
  subtitleRowStyle,
  subtitleOffsetPx,
  SUBTITLE_SIZES,
  DEFAULT_SUBTITLE_STYLE,
} from "@/lib/subtitleStyle";

beforeEach(() => window.localStorage.clear());

describe("cueCss", () => {
  // `::cue` porte un fond noir par défaut : l'ombre seule n'existe que si on l'efface
  // explicitement, et l'oublier laisserait la boîte du navigateur sous notre propre traitement.
  it("clears the browser's own cue background when the shadow is wanted", () => {
    const css = cueCss({ ...DEFAULT_SUBTITLE_STYLE, background: "shadow" });
    expect(css).toContain("background-color: transparent");
    expect(css).toContain("text-shadow:");
  });

  // Et l'inverse : une boîte se suffit, l'ombre par-dessus ne ferait que salir ses bords.
  it("drops the shadow once there is a box to sit on", () => {
    const css = cueCss({ ...DEFAULT_SUBTITLE_STYLE, background: "box" });
    expect(css).toContain("background-color: rgba(0,0,0,0.72)");
    expect(css).toContain("text-shadow: none");
  });

  it("carries the colour and scales with the size", () => {
    expect(cueCss({ ...DEFAULT_SUBTITLE_STYLE, color: "yellow" })).toContain("#f2e14c");
    const small = cueCss({ ...DEFAULT_SUBTITLE_STYLE, size: 0.75 });
    const large = cueCss({ ...DEFAULT_SUBTITLE_STYLE, size: 1.6 });
    expect(small).not.toEqual(large);
  });

  // Le plancher de 14 px était commun à toutes les tailles : sur un téléphone en portrait,
  // « Petite » y tombait, et « Très petite » aurait été la même chose.
  it("keeps each size distinct where the viewport would floor them", () => {
    const floors = [0.6, 0.75, 1].map((size) => cueCss({ ...DEFAULT_SUBTITLE_STYLE, size }).match(/clamp\((\d+)px/)![1]);
    expect(new Set(floors).size).toBe(3);
    expect(Number(floors[0])).toBeLessThan(Number(floors[1]));
  });

  // Les deux façons de dessiner suivent la même règle ; seules les unités diffèrent — la zone du
  // calque pour le lecteur natif, la fenêtre pour `::cue`, que rien ne rattache à un conteneur.
  it("is the overlay's rule, measured against the window rather than the layer", () => {
    for (const { value: size } of SUBTITLE_SIZES) {
      const cue = cueCss({ ...DEFAULT_SUBTITLE_STYLE, size }).match(/font-size: ([^;]+);/)![1];
      const overlay = String(overlayCss({ ...DEFAULT_SUBTITLE_STYLE, size }).fontSize);
      expect(overlay).toContain("cqh");
      expect(cue).not.toContain("cq");
      expect(overlay.replace(/cqh/g, "vh").replace(/cqw/g, "vw")).toBe(cue);
    }
  });
});

// 12/10/2026, « trop gros et trop hauts, ils couvrent trop d'image » : la taille suivait la largeur
// seule (4 vw), 25 px sur un téléphone en paysage de 390 px de haut. Les cibles, à « Petite » (le
// défaut), sont celles des lecteurs de référence rapportées aux écrans de la maison.
describe("subtitleFontPx", () => {
  const at = (w: number, h: number, size = DEFAULT_SUBTITLE_STYLE.size) => subtitleFontPx(size, w, h);

  it("lands on the targets at the default size", () => {
    expect(at(1920, 1080)).toBeGreaterThanOrEqual(34);
    expect(at(1920, 1080)).toBeLessThanOrEqual(38);
    expect(at(1366, 768)).toBeGreaterThanOrEqual(28);
    expect(at(1366, 768)).toBeLessThanOrEqual(30);
    expect(at(844, 390)).toBeGreaterThanOrEqual(16);
    expect(at(844, 390)).toBeLessThanOrEqual(18);
    expect(at(390, 844)).toBeGreaterThanOrEqual(13);
    expect(at(390, 844)).toBeLessThanOrEqual(15);
    expect(at(1180, 820)).toBeGreaterThanOrEqual(24);
    expect(at(1180, 820)).toBeLessThanOrEqual(28);
  });

  // La cause du retour : sur un téléphone en paysage, la largeur ne dit rien de la place qu'il y a.
  it("is held by the height when the screen is wide and short", () => {
    expect(at(844, 390)).toBeLessThan(at(844, 844));
    expect(at(844, 390) / 390).toBeLessThan(0.05);
  });

  // Et par la largeur en portrait, où la hauteur ferait un écran de bureau de quinze caractères.
  it("is held by the width when the screen is narrow and tall", () => {
    expect(at(390, 844)).toBeLessThan(at(844, 844));
  });

  it("keeps the sizes in proportion to one another", () => {
    for (const [w, h] of [[1920, 1080], [844, 390], [390, 844]]) {
      const sizes = SUBTITLE_SIZES.map(({ value }) => subtitleFontPx(value, w, h));
      expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
      expect(sizes[2] / sizes[1]).toBeCloseTo(1 / 0.75, 1);
    }
  });

  it("stops growing on a very large window", () => {
    expect(at(3840, 2160)).toBe(48);
  });
});

// Le calque était à 96 px fixes du bas : un quart d'un téléphone en paysage, commandes ou non.
describe("subtitle placement", () => {
  it("rests at 6.5 % of the height once the controls are gone, never under 12 px", () => {
    expect(subtitleOffsetPx(1080, null)).toBeCloseTo(70.2, 1);
    expect(subtitleOffsetPx(390, null)).toBeCloseTo(25.35, 1);
    expect(subtitleOffsetPx(150, null)).toBe(12);
    // La zone sûre s'ajoute : la barre d'accueil d'un iPhone ne recouvre pas la ligne.
    expect(subtitleOffsetPx(390, null, 21)).toBeCloseTo(46.35, 1);
  });

  it("rises just above the controls while they are shown, and only if it must", () => {
    expect(subtitleOffsetPx(390, 124)).toBe(124);
    expect(subtitleOffsetPx(1080, 40)).toBeCloseTo(70.2, 1);
  });

  it("moves by transform alone, from the edge it rests on", () => {
    const hidden = subtitleRowStyle(false, null);
    expect(hidden.bottom).toBe("calc(max(12px, 6.5cqh) + env(safe-area-inset-bottom, 0px))");
    expect(hidden.top).toBeUndefined();
    expect(hidden.transform).toBe("translateY(calc(-1 * 0px))");

    const shown = subtitleRowStyle(false, { top: 76, bottom: 123.6 });
    expect(shown.bottom).toBe(hidden.bottom);
    expect(shown.transform).toBe(`translateY(calc(-1 * max(0px, 124px - ${hidden.bottom})))`);
  });

  // `{\an8}` : un sous-titre placé en haut garde le haut, et s'écarte de la rangée du haut.
  it("keeps a top-placed line at the top, below the top row when it is shown", () => {
    const hidden = subtitleRowStyle(true, null);
    expect(hidden.top).toBe("calc(max(12px, 6.5cqh) + env(safe-area-inset-top, 0px))");
    expect(hidden.bottom).toBeUndefined();
    expect(subtitleRowStyle(true, { top: 76, bottom: 124 }).transform).toBe(
      `translateY(max(0px, 76px - ${hidden.top}))`
    );
  });
});

// Les deux façons de dessiner doivent dire la même chose : c'est tout l'objet de ce module.
describe("overlayCss", () => {
  it("agrees with the cue rule on colour, shadow and box", () => {
    const shadow = overlayCss({ ...DEFAULT_SUBTITLE_STYLE, background: "shadow" });
    expect(shadow.backgroundColor).toBeUndefined();
    expect(shadow.textShadow).not.toBe("none");

    const box = overlayCss({ ...DEFAULT_SUBTITLE_STYLE, background: "box" });
    expect(box.backgroundColor).toBe("rgba(0,0,0,0.72)");
    expect(box.textShadow).toBe("none");
    expect(box.padding).toBeTruthy();
  });
});

// Le magasin garde son instantané en cache pour `useSyncExternalStore` : chaque cas repart donc
// d'un module neuf, seule façon de vérifier ce qu'il lit au tout premier appel.
async function freshStore() {
  vi.resetModules();
  return (await import("@/lib/subtitleStyle")).subtitleStyleStore;
}

describe("subtitleStyleStore", () => {
  it("starts on the defaults with nothing stored", async () => {
    expect((await freshStore()).snapshot()).toEqual(DEFAULT_SUBTITLE_STYLE);
  });

  // « Petite » par défaut (23/09/2026), sans toucher à qui avait choisi « Normale ».
  it("defaults to small, and keeps a normal size someone chose", async () => {
    expect(DEFAULT_SUBTITLE_STYLE.size).toBe(0.75);
    window.localStorage.setItem("cine:subtitle-style", JSON.stringify({ ...DEFAULT_SUBTITLE_STYLE, size: 1 }));
    expect((await freshStore()).snapshot().size).toBe(1);
  });

  // Le réglage de taille existait déjà, seul, sous une autre clé. Quelqu'un qui l'avait choisi ne
  // doit pas le voir revenir à « normal » parce qu'on a ajouté deux réglages à côté.
  it("keeps a size chosen under the old key", async () => {
    window.localStorage.setItem("cine:subtitle-size", "1.3");
    expect((await freshStore()).snapshot()).toEqual({ ...DEFAULT_SUBTITLE_STYLE, size: 1.3 });
  });

  it("refuses stored values that mean nothing", async () => {
    window.localStorage.setItem(
      "cine:subtitle-style",
      JSON.stringify({ size: 99, color: "mauve", background: "néon" })
    );
    expect((await freshStore()).snapshot()).toEqual(DEFAULT_SUBTITLE_STYLE);
  });

  it("keeps what it is given and tells whoever is listening", async () => {
    const store = await freshStore();
    let told = 0;
    store.subscribe(() => (told += 1));
    store.set({ color: "yellow" });
    expect(store.snapshot().color).toBe("yellow");
    expect(told).toBe(1);
    expect(JSON.parse(window.localStorage.getItem("cine:subtitle-style")!).color).toBe("yellow");
  });
});
