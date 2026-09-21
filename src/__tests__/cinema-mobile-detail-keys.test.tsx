// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La fiche du téléphone, sous le lecteur.
 *
 * Elle reste montée sous le film pour que le refermer ramène là d'où l'on est parti — mais son
 * écouteur d'Échap, lui, restait branché : sur une tablette à clavier, une touche refermait le
 * lecteur *et* la fiche, deux crans d'historique d'un coup. Les fiches du bureau se taisaient déjà
 * (`playerOwnsKeyboard`) ; celle-ci non. Voir `playerHoldsKeyboard`.
 */
let mode: "idle" | "mini" | "full" = "idle";
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode, play: vi.fn() }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: () => new Promise(() => {}),
}));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [] }) }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const MOVIE = {
  radarrId: 1,
  tmdbId: 603,
  jellyfinItemId: "jf1",
  title: "Matrix",
  year: 1999,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
  imdbRating: null,
} as unknown as CinemaMovie;

const draw = (onClose: () => void) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={onClose} />
    </SWRConfig>
  );
const root = () => document.body.querySelector<HTMLElement>(".app-viewport")!;

beforeEach(() => {
  mode = "idle";
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CinemaMobileDetail — le clavier", () => {
  it("se ferme à Échap quand elle est à l'écran", () => {
    const onClose = vi.fn();
    draw(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.runAllTimers());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("se tait tant que le lecteur occupe l'écran", () => {
    mode = "full";
    const onClose = vi.fn();
    draw(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.runAllTimers());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("CinemaMobileDetail — la sortie", () => {
  // Même règle que les fiches du lecteur, par la même fonction (`sheetMotionClass`) : un appui sur
  // la bannière n'éteint pas l'animation de sortie des fermetures suivantes.
  it("glisse encore après un appui sur la bannière", () => {
    draw(vi.fn());
    const banner = document.body.querySelector<HTMLElement>(".aspect-video")!;
    fireEvent.pointerDown(banner, { clientY: 100, pointerId: 1, pointerType: "touch", button: 0 });
    fireEvent.pointerUp(banner, { clientY: 100, pointerId: 1, pointerType: "touch", button: 0 });
    fireEvent.click(document.body.querySelector('[aria-label="cinema.back"]')!);
    expect(root().className).toContain("sheet-out");
  });
});
