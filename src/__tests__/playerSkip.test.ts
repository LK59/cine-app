// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { activeSkip, isEmptySurface, keyboardFocusWithin, surfaceAction } from "@/lib/playerSkip";

describe("activeSkip — un seul bouton « Passer… »", () => {
  const recap = { start: 6, end: 61 };
  const intro = { start: 324, end: 414 };

  it("le récap pendant le récap, l'intro pendant l'intro, rien ailleurs", () => {
    expect(activeSkip(10, intro, recap)).toEqual({ kind: "recap", end: 61 });
    expect(activeSkip(330, intro, recap)).toEqual({ kind: "intro", end: 414 });
    expect(activeSkip(100, intro, recap)).toBeNull();
    expect(activeSkip(414, intro, recap)).toBeNull();
    expect(activeSkip(10, null, null)).toBeNull();
  });

  it("chevauchés, celui qui finit le plus tard l'emporte : un appui passe les deux", () => {
    expect(activeSkip(50, { start: 40, end: 120 }, { start: 0, end: 60 })).toEqual({ kind: "intro", end: 120 });
  });
});

describe("surfaceAction — décidé par l'appui, pas par l'appareil", () => {
  it("souris sur l'image : lecture/pause", () => {
    expect(surfaceAction("mouse", 1, true)).toBe("toggle-play");
    expect(surfaceAction("mouse", 2, true)).toBe("toggle-play");
  });
  it("doigt, stylet, appui inconnu : afficher/masquer", () => {
    expect(surfaceAction("touch", 1, true)).toBe("toggle-controls");
    expect(surfaceAction("pen", 1, true)).toBe("toggle-controls");
    expect(surfaceAction("", 1, true)).toBe("toggle-controls");
  });
  it("souris sur autre chose que l'image : comme avant", () => {
    expect(surfaceAction("mouse", 1, false)).toBe("toggle-controls");
  });
  it("un troisième clic du même geste ne fait rien", () => {
    expect(surfaceAction("mouse", 3, true)).toBe("ignore");
  });
});

describe("isEmptySurface", () => {
  it("l'image et les voiles oui ; un bouton, un curseur, ce qui se déclare à part non", () => {
    document.body.innerHTML = `<div id="root"><div id="veil"></div><button id="b"><span id="icon"></span></button><input id="r" type="range"><div data-player-surface-ignore><p id="card"></p></div></div><div id="out"></div>`;
    const root = document.getElementById("root")!;
    const at = (id: string) => isEmptySurface(document.getElementById(id), root);
    expect(isEmptySurface(root, root)).toBe(true);
    expect(at("veil")).toBe(true);
    expect(at("icon")).toBe(false);
    expect(at("r")).toBe(false);
    expect(at("card")).toBe(false);
    expect(at("out")).toBe(false);
  });
});

describe("keyboardFocusWithin", () => {
  it("rien de focalisé dans les commandes : non", () => {
    document.body.innerHTML = `<div id="root"><button id="b"></button></div><button id="o"></button>`;
    (document.getElementById("o") as HTMLButtonElement).focus();
    expect(keyboardFocusWithin(document.getElementById("root"))).toBe(false);
    expect(keyboardFocusWithin(null)).toBe(false);
  });
});
