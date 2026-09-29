// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Lecture intégrée fermée (`PLAYER_ENABLED=false`) : aucune fiche ne propose de lancer un film.
 *
 * `PlayButton` ne rendait rien, mais les deux fiches du bureau réécrivaient leur propre ligne
 * « Recommencer » sans sa garde, et les lignes d'épisode (bureau et téléphone) appelaient
 * `playback.play` quoi qu'il arrive : un bouton qui menait à « Lecteur intégré désactivé »
 * (audit du 29/09/2026, A27).
 */
const play = vi.fn();
let playerEnabled = false;
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({
  usePlayerEnabled: () => playerEnabled,
  usePlayerEnabledState: () => playerEnabled,
  usePlayerServerFallback: () => true,
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: { n?: number }) => (v?.n != null ? `${k}:${v.n}` : k),
  useLocale: () => ({ locale: "fr" }),
}));
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
  useJellyfinItemState: () => ({
    progress: { known: true, resumeTicks: 12_000_000_000, runtimeTicks: 60_000_000_000 },
    watched: false,
    known: true,
    busy: false,
    toggleWatched: vi.fn(),
  }),
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
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { CinemaEpisodeBrowser } from "@/components/cinema/CinemaEpisodeBrowser";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";

const MOVIE = {
  radarrId: 3,
  tmdbId: 99,
  jellyfinItemId: "jfm",
  title: "Un film",
  year: 1973,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaMovie;

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

const S1: CinemaSeason = {
  seasonNumber: 1,
  episodes: [
    {
      jellyfinItemId: "ep101",
      seasonNumber: 1,
      episodeNumber: 1,
      title: "Le pilote",
      overview: null,
      thumbnailUrl: null,
      runtimeMinutes: 45,
      runtimeTicks: 27_000_000_000,
      watched: false,
      resumeTicks: 6_000_000_000,
    },
  ],
};
const EPISODES = {
  seasons: [S1],
  nextEpisode: {
    itemId: "ep101",
    title: "Le pilote",
    resumeTicks: 6_000_000_000,
    runtimeTicks: 27_000_000_000,
    seasonNumber: 1,
    episodeNumber: 1,
  },
};

const withSwr = (node: React.ReactNode) => (
  <SWRConfig
    value={{
      provider: () => new Map(),
      dedupingInterval: 0,
      fallback: { "/api/cinema/series/jfs/episodes": EPISODES },
    }}
  >
    {node}
  </SWRConfig>
);

const text = () => document.body.textContent ?? "";

beforeEach(() => {
  play.mockClear();
  playerEnabled = false;
});
afterEach(() => cleanup());

describe("lecture intégrée fermée : aucune action de lecture sur les fiches", () => {
  it("fiche film du bureau : ni Lire ni « Recommencer »", () => {
    render(withSwr(<CinemaMovieDetail item={MOVIE} onClose={vi.fn()} />));
    expect(text()).toContain("Un film");
    expect(text()).not.toContain("cinema.restartFromBeginning");
  });

  it("fiche série du bureau : ni Lire ni « Recommencer »", () => {
    render(withSwr(<CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />));
    expect(text()).toContain("Une série");
    expect(text()).not.toContain("cinema.restartFromBeginning");
  });

  it("navigateur d'épisodes du bureau : la ligne ne lance rien et ne montre pas de lecture", () => {
    render(
      <CinemaEpisodeBrowser title="Une série" seasons={[S1]} sonarrId={7} onClose={vi.fn()} onPlayEpisode={play} />
    );
    const row = document.body.querySelector('[data-episode-item="true"]') as HTMLElement;
    expect(row.textContent).toContain("Le pilote");
    expect(row.querySelector("svg.lucide-play")).toBeNull();
    fireEvent.click(row);
    expect(play).not.toHaveBeenCalled();
  });

  it("liste d'épisodes du téléphone : la ligne ne lance rien et ne montre pas de lecture", () => {
    render(withSwr(<CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />));
    const row = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("Le pilote"))!;
    expect(row).toBeTruthy();
    expect(row.querySelector("svg.lucide-play")).toBeNull();
    fireEvent.click(row);
    expect(play).not.toHaveBeenCalled();
  });
});

describe("lecture intégrée ouverte : les mêmes actions sont là", () => {
  beforeEach(() => {
    playerEnabled = true;
  });

  it("« Recommencer » sur les deux fiches du bureau, et il part de zéro", () => {
    render(withSwr(<CinemaMovieDetail item={MOVIE} onClose={vi.fn()} />));
    const restart = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("cinema.restartFromBeginning")
    )!;
    expect(restart).toBeTruthy();
    // Dans le menu de la fiche : la navigation au clavier le compte.
    expect(restart.hasAttribute("data-detail-menu")).toBe(true);
    fireEvent.click(restart);
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "jfm", resumeAt: 0 }));
    cleanup();

    render(withSwr(<CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />));
    const restartEp = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("cinema.restartFromBeginning")
    )!;
    expect(restartEp).toBeTruthy();
    fireEvent.click(restartEp);
    expect(play).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "ep101", resumeAt: 0 }));
  });

  it("les lignes d'épisode lancent l'épisode", () => {
    render(
      <CinemaEpisodeBrowser title="Une série" seasons={[S1]} sonarrId={7} onClose={vi.fn()} onPlayEpisode={play} />
    );
    const row = document.body.querySelector('[data-episode-item="true"]') as HTMLElement;
    expect(row.querySelector("svg.lucide-play")).not.toBeNull();
    fireEvent.click(row);
    expect(play).toHaveBeenCalledTimes(1);
    cleanup();
    play.mockClear();

    render(withSwr(<CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />));
    const mrow = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes("Le pilote"))!;
    fireEvent.click(mrow);
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: "ep101" }));
  });
});
