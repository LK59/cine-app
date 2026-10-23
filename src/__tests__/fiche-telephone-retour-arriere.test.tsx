// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Retour arrière d'un clavier sur la fiche du téléphone (audit des fiches, 23/10/2026, V10).
 *
 * Toutes les fiches se referment à Échap et à Retour arrière — film et série du bureau, écran des
 * épisodes, fiche TMDB, fiche personne, fiche hors ligne —, sauf celle-ci, qui n'écoutait qu'Échap :
 * sur un iPad à clavier en interface tactile, Retour arrière refermait la fiche TMDB posée dessus,
 * puis plus rien. Elle passe par la même règle (`useSheetKeys`).
 */
let mode: "idle" | "full" = "idle";
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
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false, useIsTouch: () => true }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: undefined, watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [], seasonOf: () => undefined }) }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const MOVIE = {
  radarrId: 1,
  tmdbId: 603,
  jellyfinItemId: "f".repeat(32),
  title: "Matrix",
  year: 1999,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaMovie;

const draw = (onClose: () => void) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={onClose} />
    </SWRConfig>
  );

beforeEach(() => {
  mode = "idle";
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("fiche du téléphone, Retour arrière", () => {
  it("la referme, comme Échap", () => {
    const onClose = vi.fn();
    draw(onClose);
    fireEvent.keyDown(window, { key: "Backspace" });
    act(() => vi.runAllTimers());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dans un champ, efface une lettre et ne referme rien", () => {
    const onClose = vi.fn();
    draw(onClose);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(fireEvent.keyDown(input, { key: "Backspace" })).toBe(true);
    act(() => vi.runAllTimers());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("se tait tant que le lecteur occupe l'écran", () => {
    mode = "full";
    const onClose = vi.fn();
    draw(onClose);
    fireEvent.keyDown(window, { key: "Backspace" });
    act(() => vi.runAllTimers());
    expect(onClose).not.toHaveBeenCalled();
  });
});
