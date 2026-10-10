// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/components/cinema/CinemaLogo", () => ({ CinemaLogo: () => null }));
const keep = vi.fn((..._args: unknown[]) => {});
const suspend = vi.fn((..._args: unknown[]) => {});
vi.mock("@/lib/sheetMorph/prefetchBanners", () => ({
  keepSheetBanners: (...args: unknown[]) => keep(...args),
  suspendSheetBanners: (...args: unknown[]) => suspend(...args),
  releaseSheetBanners: () => {},
}));

import { CinemaMobileHero } from "@/components/cinema/mobile/CinemaMobileHero";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

// La bannière du téléphone garde décodé le visuel de toutes les fiches qu'elle ouvrirait, dès que sa
// liste est connue, avec l'adresse même que la fiche demande (`item.backdropUrl`).

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  keep.mockClear();
  suspend.mockClear();
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

describe("CinemaMobileHero — visuels des fiches gardés d'avance", () => {
  it("tous les titres de la bannière, dès le premier rendu, à l'adresse de la fiche", () => {
    render(hero([film(1), film(2), film(3), film(4)]));
    expect(keep).toHaveBeenCalled();
    const urls = keep.mock.calls.at(-1)![1] as string[];
    expect(urls.sort()).toEqual([1, 2, 3, 4].map((n) => `https://img.test/backdrop-${n}.jpg`));
  });

  it("suspendu quand la bannière n'est pas à l'écran (le lecteur plein écran)", () => {
    render(hero([film(1), film(2), film(3)], true));
    expect(keep).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalled();
  });
});
