// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watchViewportHeal } from "@/lib/viewportHeal";

/**
 * L'écran rétréci de l'application installée sur iOS (04–05/11/2026) : au retour d'une app où le
 * clavier était ouvert, la *fenêtre* garde la hauteur avec clavier (relevé : 585 sur 932). Seule une
 * fermeture de clavier la rend : au premier toucher, `watchViewportHeal` donne le focus à un champ
 * invisible — un vrai clavier — et le reprend à l'image suivante.
 */

let height = 800;
let playing = false;
let full: number | null = null;
let nudges = 0;
let reports: Record<string, unknown>[] = [];

function setup() {
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => height });
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => 390 });
  const shell = document.createElement("div");
  document.body.appendChild(shell);
  const stop = watchViewportHeal({
    win: window,
    shell: () => shell,
    playing: () => playing,
    fullHeight: () => full,
    report: (r) => reports.push(r),
  });
  return { shell, stop };
}

const realFocus = HTMLElement.prototype.focus;
beforeEach(() => {
  vi.useFakeTimers();
  height = 800;
  playing = false;
  full = null;
  nudges = 0;
  reports = [];
  document.body.innerHTML = "";
  HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
    if (this.hasAttribute("data-viewport-nudge")) nudges += 1;
    return realFocus.call(this, opts);
  };
});
afterEach(() => {
  HTMLElement.prototype.focus = realFocus;
  vi.useRealTimers();
});

const comeBack = () => {
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1000);
};

const touch = () => {
  document.dispatchEvent(new Event("touchend"));
  vi.advanceTimersByTime(1000);
};

describe("watchViewportHeal", () => {
  it("coincée au retour : rien sans geste, puis un vrai clavier au premier toucher, rendu à l'image suivante", () => {
    const { stop } = setup();
    height = 500;
    comeBack();
    expect(nudges).toBe(0);
    expect(reports.at(-1)).toMatchObject({ trigger: "retour", decision: "attend un toucher", best: 800 });
    touch();
    expect(nudges).toBe(1);
    expect(document.querySelector("[data-viewport-nudge]")).toBeNull();
    expect(reports.at(-1)).toMatchObject({ trigger: "toucher", decision: "clavier au toucher" });
    stop();
  });

  it("le champ appelle un vrai clavier : ni `inputmode=none`, ni lecture seule", () => {
    const { stop } = setup();
    height = 500;
    comeBack();
    let seen: HTMLInputElement | null = null;
    const spy = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
      if (this.hasAttribute("data-viewport-nudge")) seen = this as HTMLInputElement;
      return spy.call(this, opts);
    };
    touch();
    expect(seen).not.toBeNull();
    expect(seen!.getAttribute("inputmode")).toBeNull();
    expect(seen!.readOnly).toBe(false);
    stop();
  });

  it("une tentative par toucher, tant qu'elle reste coincée ; plus rien une fois rendue", () => {
    const { stop } = setup();
    height = 500;
    comeBack();
    touch();
    touch();
    expect(nudges).toBe(1);
    comeBack();
    touch();
    expect(nudges).toBe(2);
    height = 800;
    comeBack();
    touch();
    expect(nudges).toBe(2);
    stop();
  });

  it("une page à sa vraie hauteur n'est pas touchée", () => {
    const { stop } = setup();
    comeBack();
    touch();
    expect(nudges).toBe(0);
    expect(reports.at(-1)).toMatchObject({ decision: "rien" });
    stop();
  });

  it("ni un champ qui a le focus (le clavier est là pour de bon), ni un film qui joue", () => {
    const { shell, stop } = setup();
    height = 500;
    const input = document.createElement("input");
    shell.appendChild(input);
    input.focus();
    comeBack();
    touch();
    expect(nudges).toBe(0);
    input.remove();
    playing = true;
    comeBack();
    touch();
    expect(nudges).toBe(0);
    stop();
  });

  // La page a pu démarrer coincée, sans jamais avoir vu sa vraie hauteur — l'écran de l'iPhone la donne.
  it("une page partie coincée se répare d'après la hauteur de l'écran", () => {
    height = 500;
    full = 800;
    const { stop } = setup();
    comeBack();
    touch();
    expect(nudges).toBe(1);
    stop();
  });

  it("un rétrécissement arrivé après le retour est pris aussi", () => {
    const { stop } = setup();
    height = 500;
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(1000);
    touch();
    expect(nudges).toBe(1);
    stop();
  });
});
