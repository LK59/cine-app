// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watchViewportHeal } from "@/lib/viewportHeal";

/**
 * L'écran rétréci de l'application installée sur iOS (04/11/2026) : la page coupée aux deux tiers au
 * retour dans l'app, la hauteur du clavier restée. `watchViewportHeal` retire un instant la coquille
 * du rendu quand elle est plus basse que la plus haute vue — et seulement alors.
 */

let height = 800;
let shellHeight = 800;
let playing = false;
let full: number | null = null;

function setup() {
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => height });
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => 390 });
  const shell = document.createElement("div");
  shell.getBoundingClientRect = () => ({ height: shellHeight }) as DOMRect;
  const scroller = document.createElement("div");
  shell.appendChild(scroller);
  document.body.appendChild(shell);
  const displays: string[] = [];
  const style = shell.style;
  const real = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "display");
  Object.defineProperty(style, "display", {
    configurable: true,
    get: () => (real?.get ? real.get.call(style) : ""),
    set: (v: string) => {
      displays.push(v);
      real?.set?.call(style, v);
    },
  });
  const stop = watchViewportHeal({ win: window, shell: () => shell, playing: () => playing, fullHeight: () => full });
  return { shell, scroller, displays, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  height = 800;
  shellHeight = 800;
  playing = false;
  full = null;
  document.body.innerHTML = "";
});
afterEach(() => vi.useRealTimers());

const comeBack = () => {
  window.dispatchEvent(new Event("pageshow"));
  vi.advanceTimersByTime(400);
};

describe("watchViewportHeal", () => {
  it("une page restée à la hauteur du clavier est remesurée au retour, défilement gardé", () => {
    const { scroller, displays, stop } = setup();
    scroller.scrollTop = 120;
    shellHeight = 500;
    comeBack();
    expect(displays).toEqual(["none", ""]);
    expect(scroller.scrollTop).toBe(120);
    stop();
  });

  it("une page à sa vraie hauteur n'est pas touchée", () => {
    const { displays, stop } = setup();
    comeBack();
    expect(displays).toEqual([]);
    stop();
  });

  it("ni un champ qui a le focus (le clavier est là pour de bon), ni un film qui joue", () => {
    const { shell, displays, stop } = setup();
    shellHeight = 500;
    const input = document.createElement("input");
    shell.appendChild(input);
    input.focus();
    comeBack();
    expect(displays).toEqual([]);
    input.blur();
    playing = true;
    comeBack();
    expect(displays).toEqual([]);
    stop();
  });

  it("fermer le clavier remesure après qu'il s'est rangé", () => {
    const { shell, displays, stop } = setup();
    const input = document.createElement("input");
    shell.appendChild(input);
    input.focus();
    shellHeight = 500;
    input.blur();
    vi.advanceTimersByTime(100);
    expect(displays).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(displays).toEqual(["none", ""]);
    stop();
  });

  // Le clavier ouvert dans une autre app, puis retour dans Laterna : la page a pu démarrer coincée,
  // sans jamais avoir vu sa vraie hauteur — l'écran de l'iPhone la donne.
  it("une page partie coincée se répare d'après la hauteur de l'écran", () => {
    height = 500;
    shellHeight = 500;
    full = 800;
    const { displays, stop } = setup();
    comeBack();
    expect(displays).toEqual(["none", ""]);
    stop();
  });

  it("un rétrécissement arrivé après le retour est réparé aussi", () => {
    const { displays, stop } = setup();
    height = 500;
    shellHeight = 500;
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(400);
    expect(displays).toEqual(["none", ""]);
    stop();
  });
});
