// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/cinema/CinemaLogo", () => ({ CinemaLogo: () => null }));

import { CinemaMobileHero } from "@/components/cinema/mobile/CinemaMobileHero";
import { ROTATE_MS } from "@/lib/useRotatingIndex";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

/**
 * La bannière du téléphone quand les données fraîches remplacent celles du cache (25/09/2026) : le
 * film à l'écran y reste, la nouveauté vient au passage suivant, l'ordre officiel revient hors de
 * l'écran.
 */
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const film = (n: number) =>
  ({ radarrId: n, title: `Film ${n}`, posterUrl: null, logoUrl: null, genres: [], year: 2000 }) as unknown as CinemaMovie;
const hero = (items: CinemaMovie[], offscreen = false) => (
  <CinemaMobileHero items={items} paused={false} offscreen={offscreen} short={false} onPlay={() => {}} onOpen={() => {}} />
);
const current = () => screen.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true")?.getAttribute("aria-label");

describe("CinemaMobileHero et les données fraîches", () => {
  it("garde le film du cache à l'écran, puis montre la nouveauté au passage suivant", () => {
    const cached = [film(1), film(2), film(3)];
    const { rerender } = render(hero(cached));
    expect(current()).toBe("Film 1");

    rerender(hero([film(9), ...cached]));
    expect(current()).toBe("Film 1");

    act(() => void vi.advanceTimersByTime(ROTATE_MS));
    expect(current()).toBe("Film 9");
  });

  it("hors de l'écran, reprend l'ordre officiel : la nouveauté en premier au retour", () => {
    const cached = [film(1), film(2), film(3)];
    const fresh = [film(9), ...cached];
    const { rerender } = render(hero(cached));
    rerender(hero(fresh));
    rerender(hero(fresh, true));
    rerender(hero(fresh, false));
    expect(current()).toBe("Film 9");
    const bars = screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-current")).map((b) => b.getAttribute("aria-label"));
    expect(bars).toEqual(["Film 9", "Film 1", "Film 2", "Film 3"]);
  });
});
