// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/cinema/CinemaLogo", () => ({ CinemaLogo: () => null }));

import { CinemaMobileHero } from "@/components/cinema/mobile/CinemaMobileHero";
import { CAROUSEL_TRANSITION } from "@/lib/useCarouselDrag";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

/**
 * La bannière du téléphone (23/09/2026) :
 * - du dernier titre au premier, la piste glissait sur toute sa largeur à travers des cases
 *   vides — un saut de plus d'un cran se fait désormais sur place ;
 * - la barre de progression continuait de se remplir pendant une pause du minuteur.
 */
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const flushFrame = () =>
  act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((cb) => cb(0));
  });

const film = (n: number) =>
  ({ radarrId: n, title: `Film ${n}`, posterUrl: null, logoUrl: null, genres: [], year: 2000 }) as unknown as CinemaMovie;
const items = [film(1), film(2), film(3), film(4)];
const hero = (paused = false) => (
  <CinemaMobileHero items={items} paused={paused} short={false} onPlay={() => {}} onOpen={() => {}} />
);
const track = () => document.querySelector<HTMLElement>("section .flex[style*='transform']")!;
const bar = (title: string) => screen.getByRole("button", { name: title });

describe("CinemaMobileHero", () => {
  it("un cran glisse", () => {
    render(hero());
    act(() => void fireEvent.click(bar("Film 2")));
    expect(track().style.transition).toBe(CAROUSEL_TRANSITION);
  });

  it("un saut de plus d'un cran se fait sur place, puis le glissement revient", () => {
    render(hero());
    act(() => void fireEvent.click(bar("Film 4")));
    expect(track().style.transition).toBe("none");
    flushFrame();
    expect(track().style.transition).toBe(CAROUSEL_TRANSITION);
  });

  it("la barre se fige pendant une pause, et repart de zéro à la reprise", () => {
    const { rerender } = render(hero());
    const fill = () => bar("Film 1").querySelector<HTMLElement>(".animate-hero-fill")!;
    const before = fill();
    rerender(hero(true));
    expect(fill().style.animationPlayState).toBe("paused");
    rerender(hero(false));
    expect(fill().style.animationPlayState).toBe("running");
    expect(fill()).not.toBe(before);
  });
});
