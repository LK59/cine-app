// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Le bouton Lire des fiches de titre, regardé rendu (DECISIONS.md §1, §2, §12, §29).
 *
 * Ces règles étaient tenues par des lectures du texte des fiches, qui exigeaient que chacune écrive
 * elle-même ses appels (`useSheetPlayFacts(`, `useFileMissing(`, `progress?.known === true`,
 * `useNextEpisodeFromCache(`, `usePlaybackPrefetch(`). Les mêmes règles, sur ce que fait la fiche,
 * pour le film et la série du bureau, la fiche du téléphone et celle d'un lien de partage :
 *  * « connu » veut dire que Jellyfin a répondu, pas que la requête est revenue ;
 *  * avant le réseau, le libellé vient de l'appareil (« Reprendre », « À suivre ») et la position du
 *    serveur ; un fichier introuvable grise Lire ; le synopsis du catalogue reste ; la place de
 *    l'accroche est tenue ;
 *  * l'épisode suivant se lit dans la liste des épisodes au moment où l'épisode finit ;
 *  * la fiche prépare la lecture de ce que Lire lancerait, et de rien quand le lien est plein.
 */
const S = vi.hoisted(() => ({
  mobile: false,
  progress: undefined as undefined | { known: boolean; resumeTicks: number | null; runtimeTicks: number | null },
  data: {} as Record<string, unknown>,
  fallback: {} as Record<string, unknown>,
  missing: new Set<string>(),
  play: [] as Record<string, unknown>[],
  prefetched: [] as (string | null | undefined)[],
}));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: (s: Record<string, unknown>) => S.play.push(s) }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => S.mobile, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: S.progress, watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: (id: string | null | undefined) => !!id && S.missing.has(id) }));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: (id: string | null | undefined) => void S.prefetched.push(id) }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [], seasonOf: () => undefined }) }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null, similarRowKeyNav: () => false }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
vi.mock("@/lib/share/store", () => ({ sharesDb: {} }));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (key: string) => (key in S.data ? Promise.resolve(S.data[key]) : new Promise(() => {})),
}));

import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { ShareTitleSheet } from "@/components/shareGuest/ShareTitleSheet";
import { RESUME_KEY, NEXT_UP_KEY } from "@/lib/swr";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import type { ShareTitlePayload } from "@/app/api/share/title/route";

const MOVIE_ID = "a".repeat(32);
const SERIES_ID = "b".repeat(32);
const EP = (n: number) => `e${String(n).padStart(31, "0")}`;
const MOVIE = {
  radarrId: 3,
  tmdbId: 603,
  jellyfinItemId: MOVIE_ID,
  title: "Matrix",
  year: 1999,
  runtimeMinutes: 136,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  overview: "Catalogue.",
  genres: [],
} as unknown as CinemaMovie;
const SERIES = {
  sonarrId: 7,
  tmdbId: 1396,
  jellyfinItemId: SERIES_ID,
  title: "Breaking Bad",
  year: 2008,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  overview: "Catalogue.",
  genres: [],
} as unknown as CinemaSeries;
const EPISODES = {
  seasons: [
    {
      seasonNumber: 1,
      episodes: [
        { jellyfinItemId: EP(101), seasonNumber: 1, episodeNumber: 1, title: "Un", overview: null, thumbnailUrl: null, runtimeMinutes: 47, runtimeTicks: 28_200_000_000, watched: false, resumeTicks: 6_000_000_000 },
        { jellyfinItemId: EP(102), seasonNumber: 1, episodeNumber: 2, title: "Deux", overview: null, thumbnailUrl: null, runtimeMinutes: 47, runtimeTicks: 28_200_000_000, watched: false, resumeTicks: null },
      ],
    },
  ],
  nextEpisode: { itemId: EP(101), title: "Un", resumeTicks: 6_000_000_000, runtimeTicks: 28_200_000_000, seasonNumber: 1, episodeNumber: 1 },
};
const progressKey = `/api/cinema/progress/${MOVIE_ID}`;
const episodesKey = `/api/cinema/series/${SERIES_ID}/episodes`;

beforeEach(() => {
  S.mobile = false;
  S.progress = undefined;
  S.data = {};
  S.fallback = {};
  S.missing = new Set();
  S.play = [];
  S.prefetched = [];
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function draw(node: React.ReactNode) {
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, fallback: S.fallback }}>{node}</SWRConfig>);
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}

/** Le bouton Lire de la fiche — pas « Recommencer », pas « Lire le fichier téléchargé ». */
function playButton(): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((b) => {
    const text = b.textContent ?? "";
    return /common\.(play|resume)|cinema\.fileMissing/.test(text) && !/restart/i.test(text);
  });
  expect(found).toBeDefined();
  return found!;
}

const FILM = [
  ["la fiche film du bureau", false, () => <CinemaMovieDetail item={MOVIE} onClose={vi.fn()} />],
  ["la fiche film du téléphone", true, () => <CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} />],
] as const;
const SERIE = [
  ["la fiche série du bureau", false, () => <CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />],
  ["la fiche série du téléphone", true, () => <CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />],
] as const;

describe.each(FILM)("%s", (_name, mobile, sheet) => {
  it("« connu » veut dire que Jellyfin a répondu : une réponse `known: false` laisse la position au serveur", async () => {
    S.mobile = mobile;
    S.progress = { known: false, resumeTicks: 30_000_000_000, runtimeTicks: 81_600_000_000 };
    S.data[progressKey] = S.progress;
    await draw(sheet());
    fireEvent.click(playButton());
    expect(S.play).toHaveLength(1);
    expect(S.play[0].itemId).toBe(MOVIE_ID);
    expect(S.play[0].resumeAt).toBeUndefined();
  });

  it("Jellyfin a répondu : sa position, à la seconde", async () => {
    S.mobile = mobile;
    S.progress = { known: true, resumeTicks: 30_000_000_000, runtimeTicks: 81_600_000_000 };
    S.data[progressKey] = S.progress;
    await draw(sheet());
    fireEvent.click(playButton());
    expect(S.play[0].resumeAt).toBe(3000);
  });

  it("avant le réseau : « Reprendre » vient de l'appareil, la position du serveur", async () => {
    S.mobile = mobile;
    S.fallback[RESUME_KEY] = { items: [{ id: MOVIE_ID, positionTicks: 30_000_000_000, runtimeTicks: 81_600_000_000, cinemaHref: "/radarr/3" }] };
    await draw(sheet());
    expect(playButton().textContent).toContain("common.resume");
    fireEvent.click(playButton());
    expect(S.play[0].resumeAt).toBeUndefined();
  });

  it("un fichier introuvable grise Lire, qui ne lance rien", async () => {
    S.mobile = mobile;
    S.missing.add(MOVIE_ID);
    await draw(sheet());
    const button = playButton();
    expect(button.textContent).toContain("cinema.fileMissing");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(S.play).toHaveLength(0);
  });

  it("le synopsis du catalogue reste quand TMDB répond, et la place de l'accroche est tenue avant", async () => {
    S.mobile = mobile;
    await draw(sheet());
    expect(document.body.querySelector("[data-sheet-reserved]")).not.toBeNull();
    cleanup();
    S.data[`/api/radarr/movies/3/info`] = { imdbId: null, trailerKey: null, tmdb: { overview: "TMDB.", tagline: null, cast: [] } };
    await draw(sheet());
    expect(document.body.textContent).toContain("Catalogue.");
    expect(document.body.textContent).not.toContain("TMDB.");
  });

  it("prépare la lecture du film", async () => {
    S.mobile = mobile;
    await draw(sheet());
    expect(S.prefetched).toContain(MOVIE_ID);
    expect(S.prefetched.every((id) => id === MOVIE_ID)).toBe(true);
  });
});

describe.each(SERIE)("%s", (_name, mobile, sheet) => {
  it("avant le réseau : l'épisode « À suivre » de l'appareil, la position du serveur", async () => {
    S.mobile = mobile;
    S.fallback[NEXT_UP_KEY] = {
      items: [{ jellyfinItemId: EP(102), title: "Deux", thumbnailUrl: null, seasonNumber: 1, episodeNumber: 2, resumeTicks: 6_000_000_000, runtimeTicks: 28_200_000_000, sonarrId: 7 }],
    };
    await draw(sheet());
    expect(playButton().textContent).toContain("cinema.episodeShort");
    fireEvent.click(playButton());
    expect(S.play[0].itemId).toBe(EP(102));
    expect(S.play[0].resumeAt).toBeUndefined();
    expect(S.prefetched).toContain(EP(102));
  });

  it("l'épisode suivant se lit dans la liste des épisodes, au moment où il finit", async () => {
    S.mobile = mobile;
    S.data[episodesKey] = EPISODES;
    await draw(sheet());
    fireEvent.click(playButton());
    expect(S.play[0].itemId).toBe(EP(101));
    expect(S.play[0].resumeAt).toBe(600);
    const next = S.play[0].getNextEpisode as (id: string) => { itemId: string } | null;
    expect(next(EP(101))?.itemId).toBe(EP(102));
    expect(next(EP(102))).toBeNull();
  });

  it("l'épisode à suivre introuvable grise Lire", async () => {
    S.mobile = mobile;
    S.data[episodesKey] = EPISODES;
    S.missing.add(EP(101));
    await draw(sheet());
    expect(playButton().textContent).toContain("cinema.fileMissing");
    expect(playButton().disabled).toBe(true);
  });
});

const sharePayload = (over: Record<string, unknown> = {}): ShareTitlePayload =>
  ({ kind: "series", item: SERIES, expiresAt: Date.UTC(2026, 9, 27, 20, 0), maxStreams: 3, playingElsewhere: 0, ...over }) as ShareTitlePayload;

describe("la fiche d'un lien de partage", () => {
  it("prépare la lecture de l'épisode que Lire lancerait, et de rien quand le lien est plein", async () => {
    S.data[episodesKey] = EPISODES;
    await draw(<ShareTitleSheet payload={sharePayload()} />);
    expect(S.prefetched).toContain(EP(101));
    cleanup();
    S.prefetched = [];
    await draw(<ShareTitleSheet payload={sharePayload({ playingElsewhere: 3 })} />);
    expect(S.prefetched.length).toBeGreaterThan(0);
    expect(S.prefetched.every((id) => id === null)).toBe(true);
  });

  it("l'épisode suivant se lit dans la liste des épisodes", async () => {
    S.data[episodesKey] = EPISODES;
    await draw(<ShareTitleSheet payload={sharePayload()} />);
    fireEvent.click(playButton());
    const next = S.play[0].getNextEpisode as (id: string) => { itemId: string } | null;
    expect(next(EP(101))?.itemId).toBe(EP(102));
  });
});
