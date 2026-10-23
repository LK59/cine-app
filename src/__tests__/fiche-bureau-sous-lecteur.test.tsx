// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Les fiches film et série du bureau sous le lecteur (DECISIONS.md §7.3), regardées rendues.
 *
 * `decisions-partagees.test.ts` exigeait `playerHoldsKeyboard(playback)` écrit dans chacune des deux
 * fiches. La même règle, sur la fiche : tant que le film occupe l'écran, ni Échap, ni Retour arrière,
 * ni les flèches n'agissent sur elle (le lecteur a les siennes) ; le film refermé, elle reprend le
 * clavier, et le focus revient sur sa première action.
 */
const S = vi.hoisted(() => ({ mode: "full" as "idle" | "mini" | "full" }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: S.mode, play: vi.fn() }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
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
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], seasonOf: () => undefined }) }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: undefined, watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null, similarRowKeyNav: () => false }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const MOVIE = { radarrId: 3, tmdbId: 99, jellyfinItemId: "a".repeat(32), title: "Un film", year: 1973, posterUrl: null, backdropUrl: null, logoUrl: null, genres: [] } as unknown as CinemaMovie;
const SERIES = {
  sonarrId: 7,
  tmdbId: 1234,
  jellyfinItemId: "b".repeat(32),
  title: "Une série",
  year: 1990,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
  firstEpisode: { itemId: "e".repeat(32), runtimeTicks: 1 },
} as unknown as CinemaSeries;

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;
const menuRows = () => Array.from(document.body.querySelectorAll<HTMLElement>("[data-detail-menu]"));

beforeEach(() => {
  S.mode = "full";
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe.each([
  ["la fiche film du bureau", (onClose: () => void) => <CinemaMovieDetail item={MOVIE} onClose={onClose} />],
  ["la fiche série du bureau", (onClose: () => void) => <CinemaSeriesDetail item={SERIES} onClose={onClose} />],
] as const)("%s", (_name, draw) => {
  it("sous le film plein écran : ni Échap, ni Retour arrière, ni les flèches", () => {
    const onClose = vi.fn();
    render(withSwr(draw(onClose)));
    act(() => vi.runOnlyPendingTimers());
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Backspace" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    act(() => vi.runAllTimers());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
  });

  it("le film refermé : la fiche reprend le clavier, et le focus revient sur sa première action", () => {
    const onClose = vi.fn();
    const { rerender } = render(withSwr(draw(onClose)));
    act(() => vi.runOnlyPendingTimers());
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    S.mode = "idle";
    rerender(withSwr(draw(onClose)));
    act(() => vi.runOnlyPendingTimers());
    // La première action du menu (`focusFirstAction`) : une ligne du menu, plus le bouton du dehors.
    expect(document.activeElement).not.toBe(outside);
    expect(menuRows()).toContain(document.activeElement);
    expect((document.activeElement as HTMLElement).closest("[data-detail-actions]")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => vi.runAllTimers());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
