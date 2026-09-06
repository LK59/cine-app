// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cueCss, overlayCss, DEFAULT_SUBTITLE_STYLE } from "@/lib/subtitleStyle";

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
