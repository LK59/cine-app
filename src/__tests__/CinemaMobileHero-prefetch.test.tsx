// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/cinema/CinemaLogo", () => ({ CinemaLogo: () => null }));
const prefetch = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@/lib/sheetMorph/prefetchBanners", () => ({ prefetchSheetBanners: (...args: unknown[]) => prefetch(...args) }));

import { CinemaMobileHero } from "@/components/cinema/mobile/CinemaMobileHero";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

// La bannière du téléphone demande d'avance le visuel des fiches qu'elle ouvrirait — le titre
// affiché et ses deux voisins — avec l'adresse même que la fiche demande (`item.backdropUrl`).

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  prefetch.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const film = (n: number) =>
  ({ radarrId: n, title: `Film ${n}`, posterUrl: null, logoUrl: null, backdropUrl: `https://img.test/backdrop-${n}.jpg`, genres: [], year: 2000 }) as unknown as CinemaMovie;
const hero = (items: CinemaMovie[], offscreen = false) => (
  <CinemaMobileHero items={items} paused={false} offscreen={offscreen} short={false} onPlay={() => {}} onOpen={() => {}} />
);

describe("CinemaMobileHero — visuels des fiches demandés d'avance", () => {
  it("le titre affiché et ses deux voisins, à l'adresse de la fiche", () => {
    render(hero([film(1), film(2), film(3), film(4)]));
    expect(prefetch).toHaveBeenCalled();
    const urls = prefetch.mock.calls.at(-1)![0] as string[];
    expect(urls).toEqual(["https://img.test/backdrop-1.jpg", "https://img.test/backdrop-2.jpg", "https://img.test/backdrop-4.jpg"]);
  });

  it("rien quand la bannière n'est pas à l'écran (le lecteur plein écran)", () => {
    render(hero([film(1), film(2), film(3)], true));
    expect(prefetch).not.toHaveBeenCalled();
  });
});
