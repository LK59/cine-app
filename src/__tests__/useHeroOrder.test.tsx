// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { heroSignature, useHeroOrder } from "@/lib/heroCarousel";
import { ROTATE_MS } from "@/lib/useRotatingIndex";

/**
 * La rotation de la bannière face à des données qui changent (25/09/2026) : le cache d'abord, les
 * données fraîches un instant après.
 */
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function hero(initial: string[], offscreen = false, paused = false) {
  return renderHook(({ keys, off, pause }) => useHeroOrder(heroSignature(keys), pause, off), {
    initialProps: { keys: initial, off: offscreen, pause: paused },
  });
}
const shown = (r: { current: [number, unknown, string[]] }) => r.current[2][r.current[0]];

describe("useHeroOrder", () => {
  it("garde à l'écran le titre du cache quand les données fraîches arrivent, et montre la nouveauté au passage suivant", () => {
    const { result, rerender } = hero(["a", "b", "c"]);
    expect(shown(result)).toBe("a");
    rerender({ keys: ["n", "a", "b", "c"], off: false, pause: false });
    expect(shown(result)).toBe("a");
    act(() => void vi.advanceTimersByTime(ROTATE_MS));
    expect(shown(result)).toBe("n");
  });

  it("ne bouge rien sans nouveauté", () => {
    const { result, rerender } = hero(["a", "b", "c"]);
    act(() => void vi.advanceTimersByTime(ROTATE_MS));
    expect(shown(result)).toBe("b");
    rerender({ keys: ["c", "b", "a"], off: false, pause: false });
    expect(result.current[2]).toEqual(["a", "b", "c"]);
    expect(shown(result)).toBe("b");
  });

  it("hors de l'écran, reprend l'ordre officiel depuis le début — la nouveauté en premier", () => {
    const { result, rerender } = hero(["a", "b", "c"]);
    rerender({ keys: ["n", "a", "b", "c"], off: false, pause: false });
    expect(result.current[2]).toEqual(["a", "n", "b", "c"]);
    rerender({ keys: ["n", "a", "b", "c"], off: true, pause: false });
    expect(result.current[2]).toEqual(["n", "a", "b", "c"]);
    // Et c'est ce qu'on retrouve en revenant.
    rerender({ keys: ["n", "a", "b", "c"], off: false, pause: false });
    expect(shown(result)).toBe("n");
  });

  it("ne tourne pas pendant une interaction, ni hors de l'écran", () => {
    const { result, rerender } = hero(["a", "b", "c"], false, true);
    act(() => void vi.advanceTimersByTime(ROTATE_MS * 2));
    expect(shown(result)).toBe("a");
    rerender({ keys: ["a", "b", "c"], off: true, pause: false });
    act(() => void vi.advanceTimersByTime(ROTATE_MS * 2));
    expect(result.current[0]).toBe(0);
  });

  it("garde un réglage stable, pour la mémoïsation de la bannière du téléphone", () => {
    const { result, rerender } = hero(["a", "b"]);
    const set = result.current[1];
    rerender({ keys: ["a", "b"], off: false, pause: false });
    expect(result.current[1]).toBe(set);
    act(() => set(1));
    expect(shown(result)).toBe("b");
  });
});
