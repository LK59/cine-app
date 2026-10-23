// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * « À voir » sur la fiche film du bureau, pour un film sans identifiant TMDB (audit des fiches,
 * 23/10/2026, V4).
 *
 * Depuis §89, un film que Jellyfin a seul et que TMDB ne connaît pas porte `tmdbId: 0`. La fiche
 * série du bureau et celle du téléphone demandent `canJoinWatchlist` avant de dessiner le bouton ; la
 * fiche film non — §6 bis la disait toujours munie d'un identifiant Radarr → TMDB. L'appui envoyait
 * `tmdbId: 0`, la route répondait 400, et la fiche en affichait l'erreur.
 */
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }) }));
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
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", async (importOriginal) => ({
  // La vraie règle (`canJoinWatchlist`) : c'est elle que la fiche doit demander.
  ...(await importOriginal<typeof import("@/lib/useAddToWatchlist")>()),
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
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
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const film = (tmdbId: number) =>
  ({
    radarrId: 1_000_000_123,
    source: "jellyfin",
    tmdbId,
    jellyfinItemId: "c".repeat(32),
    title: "Un film de Jellyfin seul",
    year: 2001,
    posterUrl: null,
    backdropUrl: null,
    logoUrl: null,
    genres: [],
  }) as unknown as CinemaMovie;

const draw = (item: CinemaMovie) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CinemaMovieDetail item={item} onClose={vi.fn()} />
    </SWRConfig>
  );

const listRow = () =>
  Array.from(document.body.querySelectorAll("[data-detail-menu]")).find((b) => /watchlist\.statuses\.toWatch|cinema\.inMyList/.test(b.textContent ?? ""));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("fiche film du bureau, « À voir »", () => {
  it("n'est pas proposé à un film sans identifiant TMDB", () => {
    draw(film(0));
    expect(listRow()).toBeUndefined();
  });

  it("reste proposé à un film qui en a un", () => {
    draw(film(603));
    expect(listRow()).toBeDefined();
  });
});
