// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { AnimatedNumber } from "@/lib/useTweenedNumber";

/**
 * Un nombre qui défile jusqu'à sa nouvelle valeur (23/09/2026) — pas au premier affichage, pas
 * quand l'appareil demande moins de mouvement.
 */
let frames: FrameRequestCallback[] = [];
let clock = 0;
let reduced = false;
beforeEach(() => {
  frames = [];
  clock = 0;
  reduced = false;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const frame = (ms: number) =>
  act(() => {
    clock = ms;
    frames.splice(0).forEach((cb) => cb(ms));
  });

describe("AnimatedNumber", () => {
  it("affiche d'emblée la valeur d'arrivée", () => {
    const { container } = render(<AnimatedNumber value={42} />);
    expect(container.textContent).toBe("42");
    expect(frames).toEqual([]);
  });

  it("défile de l'ancienne valeur vers la nouvelle, et s'y arrête", () => {
    const { container, rerender } = render(<AnimatedNumber value={10} />);
    rerender(<AnimatedNumber value={20} />);
    expect(container.textContent).toBe("10");
    frame(100);
    const mid = Number(container.textContent);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(20);
    frame(500);
    expect(container.textContent).toBe("20");
    expect(frames).toEqual([]);
  });

  it("saute directement quand l'appareil demande moins de mouvement", () => {
    reduced = true;
    const { container, rerender } = render(<AnimatedNumber value={10} />);
    rerender(<AnimatedNumber value={20} />);
    frame(16);
    expect(container.textContent).toBe("20");
  });
});

describe("où les nombres défilent", () => {
  const lire = async (f: string) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    return fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");
  };

  it("le pourcentage d'un téléchargement", async () => {
    expect(await lire("src/components/cinema/CinemaDetailExtras.tsx")).toMatch(/useTweenedNumber\(downloadPercent\(progress\)\)/);
  });

  // Les cartes de chiffres du haut ont été retirées le 23/09/2026 : elles répétaient ces compteurs.
  it("les compteurs de « Ma liste » — mais ni quand on filtre, ni à l'arrivée des données", async () => {
    const src = await lire("src/components/player/PlayerListPanel.tsx");
    expect(src).toContain("<AnimatedNumber key={`${query}:${data ? 1 : 0}`} value={counts[key]} />");
  });

  it("les chiffres de la gestion, quand ce sont des nombres", async () => {
    const src = await lire("src/app/(dashboard)/DashboardClient.tsx");
    expect(src.match(/typeof value === "number" \? <AnimatedNumber value=\{value\} \/> : value/g)?.length).toBe(2);
  });
});
