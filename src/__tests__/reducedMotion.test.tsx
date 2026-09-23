// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { prefersReducedMotion, scrollBehavior, usePrefersReducedMotion } from "@/lib/reducedMotion";
import { useRotatingIndex, ROTATE_MS } from "@/lib/useRotatingIndex";

/**
 * « Réduire les animations », respecté partout (23/09/2026).
 *
 * globals.css l'appliquait aux animations, mais remplaçait les sorties par un fondu d'entrée —
 * une fiche qui se fermait restait visible 280 ms puis disparaissait d'un coup —, et le JavaScript
 * l'ignorait : rotations automatiques, défilements `smooth`.
 */
let reduced = false;
let listeners: Array<() => void> = [];
beforeEach(() => {
  reduced = false;
  listeners = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return query.includes("prefers-reduced-motion") && reduced;
    },
    addEventListener: (_: string, l: () => void) => listeners.push(l),
    removeEventListener: (_: string, l: () => void) => (listeners = listeners.filter((x) => x !== l)),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("le réglage lui-même", () => {
  it("se lit, et donne le comportement de défilement", () => {
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");
    reduced = true;
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
  });

  it("est suivi quand on le change, écran ouvert", () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    reduced = true;
    act(() => listeners.forEach((l) => l()));
    expect(result.current).toBe(true);
  });
});

describe("la rotation des bannières", () => {
  it("tourne d'ordinaire", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRotatingIndex(3));
    act(() => void vi.advanceTimersByTime(ROTATE_MS));
    expect(result.current[0]).toBe(1);
  });

  it("s'arrête quand l'appareil demande moins de mouvement", () => {
    reduced = true;
    vi.useFakeTimers();
    const { result } = renderHook(() => useRotatingIndex(3));
    act(() => void vi.advanceTimersByTime(ROTATE_MS * 3));
    expect(result.current[0]).toBe(0);
    // Un geste, lui, déplace toujours.
    act(() => result.current[1](2));
    expect(result.current[0]).toBe(2);
  });
});

const root = path.resolve(__dirname, "..");
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

describe("ce qui ne doit pas revenir", () => {
  it("aucun défilement animé écrit en dur", () => {
    const offenders = sources(root).filter((f) => /behavior:\s*["']smooth["']\s*[,}]/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("aucune sortie remplacée par un fondu d'entrée, et les indicateurs tournent encore", () => {
    const css = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g)].map((m) => m[0]);
    expect(blocks.join("\n")).not.toContain("animation-name: fade-in");
    expect(blocks.join("\n")).toMatch(/\.animate-spin \{[^}]*animation-iteration-count: infinite !important/);
  });
});
