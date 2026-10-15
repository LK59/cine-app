// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * `#serie=…&episodes=1` ouvert par l'adresse (rechargement, lien) — 15/10/2026, passe de nuit,
 * BUREAU-23.
 *
 * L'écran des épisodes posait le focus sur sa saison, puis la fiche série dessous, dont l'effet de
 * focus se relance à l'arrivée de `nextEpisode`, le reprenait pour son « À suivre » — caché sous
 * les épisodes : aucune flèche ne bougeait plus rien.
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
const EPISODES = {
  seasons: [
    {
      seasonNumber: 1,
      episodes: [
        { jellyfinItemId: "e1", seasonNumber: 1, episodeNumber: 1, title: "Pilote", overview: null, thumbnailUrl: null, runtimeMinutes: 45, runtimeTicks: 27_000_000_000, watched: false, resumeTicks: null },
      ],
    },
  ],
  nextEpisode: { itemId: "e1", title: "Pilote", seasonNumber: 1, episodeNumber: 1 },
};
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (key: string) => (key.endsWith("/episodes") ? EPISODES : new Promise(() => {})),
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

const frames = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
  });

describe("fiche série du bureau, épisodes ouverts par l'adresse", () => {
  it("laisse le focus sur la saison de l'écran des épisodes", async () => {
    window.history.replaceState(null, "", "/#serie=7&episodes=1&tab=series");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />
      </SWRConfig>
    );
    await waitFor(() => expect(document.body.querySelector('[data-episode-season="true"]')).not.toBeNull());
    await frames();
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-episode-season")).toBe("true");
  });
});
