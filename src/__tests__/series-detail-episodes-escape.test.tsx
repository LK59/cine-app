// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * `#serie=…&episodes=1` sans l'écran des épisodes dessiné (13/10/2026).
 *
 * La fiche série du bureau laissait Échap à l'écran des épisodes dès que l'adresse le nommait ; or
 * cet écran attend sa liste (`/episodes`). Après un rechargement ou un retour sur cette entrée,
 * Échap ne faisait rien tant qu'elle n'était pas là — et plus jamais si elle échouait.
 */
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({
  usePlayerEnabled: () => true,
  usePlayerEnabledState: () => true,
  usePlayerServerFallback: () => true,
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
// La liste des épisodes ne répond jamais.
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
vi.mock("@/lib/usePlayerSeriesRequests", () => ({
  usePlayerSeriesRequests: () => ({ seasons: [], seasonOf: () => undefined }),
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: { known: false }, watched: false, known: false, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({
  useCinemaSimilar: () => [],
  CinemaSimilarRow: () => null,
  similarRowKeyNav: () => false,
}));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const SERIES = {
  sonarrId: 7,
  tmdbId: 1234,
  jellyfinItemId: "jfs",
  title: "Une série",
  year: 1990,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaSeries;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("fiche série du bureau, adresse « épisodes » sans l'écran", () => {
  it("Échap referme le cran des épisodes, pas la fiche, et ne reste pas muet", () => {
    window.history.replaceState(null, "", "/#serie=7&episodes=1&tab=series");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    const onClose = vi.fn();
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CinemaSeriesDetail item={SERIES} onClose={onClose} />
      </SWRConfig>
    );
    // L'écran des épisodes n'est pas dessiné : sa liste n'est pas là.
    expect(document.body.querySelector('[data-episode-season="true"]')).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(window.location.hash).not.toContain("episodes=1");
    expect(window.location.hash).toContain("serie=7");
    expect(onClose).not.toHaveBeenCalled();
  });
});
