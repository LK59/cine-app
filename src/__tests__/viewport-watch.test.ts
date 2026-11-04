// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watchViewportStuck } from "@/lib/viewportWatch";

/**
 * La hauteur que iOS 26 laisse coincée dans l'application installée (04–05/11/2026) : relevée, pas
 * réparée — trois réparations mesurées sans effet ont été retirées. Le relevé dit quand une version
 * d'iOS l'aura corrigée.
 */

let height = 800;
let playing = false;
let full: number | null = null;
let reports: Record<string, unknown>[] = [];

function setup() {
  Object.defineProperty(window, "innerHeight", { configurable: true, get: () => height });
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => 390 });
  const shell = document.createElement("div");
  document.body.appendChild(shell);
  const stop = watchViewportStuck({ win: window, shell: () => shell, playing: () => playing, fullHeight: () => full, report: (r) => reports.push(r) });
  return { shell, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  height = 800;
  playing = false;
  full = null;
  reports = [];
  document.body.innerHTML = "";
});
afterEach(() => vi.useRealTimers());

const comeBack = () => {
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1000);
};

describe("watchViewportStuck", () => {
  it("une fenêtre revenue à la hauteur du clavier est relevée « coincée », avec la référence", () => {
    const { stop } = setup();
    height = 500;
    comeBack();
    expect(reports.at(-1)).toMatchObject({ trigger: "retour", decision: "coincée", best: 800, before: { inner: 500 } });
    stop();
  });

  it("un retour à la bonne hauteur est relevé « rien »", () => {
    const { stop } = setup();
    comeBack();
    expect(reports.at(-1)).toMatchObject({ decision: "rien" });
    stop();
  });

  it("le vrai clavier de la page ou un film en cours se disent comme tels", () => {
    const { shell, stop } = setup();
    height = 500;
    const input = document.createElement("input");
    shell.appendChild(input);
    input.focus();
    comeBack();
    expect(reports.at(-1)).toMatchObject({ decision: "champ" });
    input.remove();
    playing = true;
    comeBack();
    expect(reports.at(-1)).toMatchObject({ decision: "film" });
    stop();
  });

  // La page a pu démarrer coincée, sans jamais avoir vu sa vraie hauteur — l'écran de l'iPhone la donne.
  it("une page partie coincée est reconnue d'après la hauteur de l'écran", () => {
    height = 500;
    full = 800;
    const { stop } = setup();
    comeBack();
    expect(reports.at(-1)).toMatchObject({ decision: "coincée", best: 800 });
    stop();
  });
});
