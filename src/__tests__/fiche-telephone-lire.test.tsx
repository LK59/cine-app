// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Le gros bouton Lire de la fiche du téléphone, et « Recommencer » (DECISIONS.md §1, §29), regardés
 * rendus.
 *
 * `decisions-partagees.test.ts` exigeait `resumeAtFor(` écrit dans la fiche du téléphone. La même
 * règle, sur ce que fait le bouton :
 *  * appuyé avant la réponse de Jellyfin, il laisse la position au serveur ; après, il la donne ;
 *  * « Recommencer » dit zéro, explicitement, et n'existe que pour une reprise connue ;
 *  * une série supposée (le S1·É1 du catalogue) retient l'appui et lance ce que le serveur répond ;
 *  * un fichier introuvable ne lance rien ;
 *  * une série porte la suite au lecteur, un film non.
 */
const S = vi.hoisted(() => ({
  progress: undefined as undefined | { known: boolean; resumeTicks: number | null; runtimeTicks: number | null },
  data: {} as Record<string, unknown>,
  missing: new Set<string>(),
  play: [] as Record<string, unknown>[],
  release: null as null | (() => void),
}));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: (s: Record<string, unknown>) => S.play.push(s) }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false, useIsTouch: () => true }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: S.progress, watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: (id: string | null | undefined) => !!id && S.missing.has(id) }));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [], seasonOf: () => undefined }) }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (key: string) => {
    if (key.endsWith("/episodes") && "held" in S.data) return new Promise((resolve) => (S.release = () => resolve(S.data.held)));
    return key in S.data ? Promise.resolve(S.data[key]) : new Promise(() => {});
  },
}));

import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const MOVIE_ID = "a".repeat(32);
const SERIES_ID = "b".repeat(32);
const EP1 = "e".repeat(32);
const EP3 = "f".repeat(32);
const MOVIE = { radarrId: 3, tmdbId: 603, jellyfinItemId: MOVIE_ID, title: "Matrix", year: 1999, posterUrl: null, backdropUrl: null, logoUrl: null, genres: [] } as unknown as CinemaMovie;
const SERIES = {
  sonarrId: 7,
  tmdbId: 1396,
  jellyfinItemId: SERIES_ID,
  title: "Breaking Bad",
  year: 2008,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
  firstEpisode: { itemId: EP1, runtimeTicks: 28_200_000_000 },
} as unknown as CinemaSeries;
const EPISODES = {
  seasons: [
    {
      seasonNumber: 1,
      episodes: [
        { jellyfinItemId: EP1, seasonNumber: 1, episodeNumber: 1, title: "Un", overview: null, thumbnailUrl: null, runtimeMinutes: 47, runtimeTicks: 28_200_000_000, watched: true, resumeTicks: null },
        { jellyfinItemId: EP3, seasonNumber: 1, episodeNumber: 3, title: "Trois", overview: null, thumbnailUrl: null, runtimeMinutes: 47, runtimeTicks: 28_200_000_000, watched: false, resumeTicks: 6_000_000_000 },
      ],
    },
  ],
  nextEpisode: { itemId: EP3, title: "Trois", resumeTicks: 6_000_000_000, runtimeTicks: 28_200_000_000, seasonNumber: 1, episodeNumber: 3 },
};

beforeEach(() => {
  S.progress = undefined;
  S.data = {};
  S.missing = new Set();
  S.play = [];
  S.release = null;
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function draw(node: React.ReactNode) {
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>);
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
}
const button = (re: RegExp) => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((b) => re.test(b.textContent ?? ""));
const playButton = () => button(/common\.(play|resume)|cinema\.fileMissing|cinema\.episodeShort/)!;

describe("fiche du téléphone — le bouton Lire", () => {
  it("un film : avant la réponse de Jellyfin, la position au serveur ; après, la sienne ; pas de suite", async () => {
    await draw(<CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} />);
    fireEvent.click(playButton());
    expect(S.play[0]).toMatchObject({ itemId: MOVIE_ID, title: "Matrix" });
    expect(S.play[0].resumeAt).toBeUndefined();
    expect(S.play[0].getNextEpisode).toBeUndefined();
    cleanup();
    S.play = [];
    S.progress = { known: true, resumeTicks: 30_000_000_000, runtimeTicks: 81_600_000_000 };
    await draw(<CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} />);
    fireEvent.click(playButton());
    expect(S.play[0].resumeAt).toBe(3000);
  });

  it("« Recommencer » dit zéro, et n'existe que pour une reprise connue", async () => {
    await draw(<CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} />);
    expect(button(/cinema\.restartFromBeginning/)).toBeUndefined();
    cleanup();
    S.progress = { known: true, resumeTicks: 30_000_000_000, runtimeTicks: 81_600_000_000 };
    await draw(<CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} />);
    fireEvent.click(button(/cinema\.restartFromBeginning/)!);
    expect(S.play).toHaveLength(1);
    expect(S.play[0]).toMatchObject({ itemId: MOVIE_ID, resumeAt: 0 });
  });

  it("un fichier introuvable : Lire grisé ne lance rien, et pas de « Recommencer »", async () => {
    S.missing.add(MOVIE_ID);
    S.progress = { known: true, resumeTicks: 30_000_000_000, runtimeTicks: 81_600_000_000 };
    await draw(<CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} />);
    const b = playButton();
    expect(b.textContent).toContain("cinema.fileMissing");
    expect(b.disabled).toBe(true);
    fireEvent.click(b);
    expect(S.play).toHaveLength(0);
    expect(button(/cinema\.restartFromBeginning/)).toBeUndefined();
  });

  it("une série supposée retient l'appui, et lance l'épisode que le serveur répond", async () => {
    S.data.held = EPISODES;
    await draw(<CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />);
    fireEvent.click(playButton());
    expect(S.play).toHaveLength(0);
    await act(async () => {
      S.release?.();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(S.play).toHaveLength(1);
    expect(S.play[0]).toMatchObject({ itemId: EP3, title: "Trois", resumeAt: 600 });
    expect(typeof S.play[0].getNextEpisode).toBe("function");
  });

  it("une série dont la liste est là : « Recommencer » l'épisode à zéro, avec la suite", async () => {
    S.data[`/api/cinema/series/${SERIES_ID}/episodes`] = EPISODES;
    await draw(<CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />);
    fireEvent.click(button(/cinema\.restartFromBeginning/)!);
    expect(S.play[0]).toMatchObject({ itemId: EP3, resumeAt: 0 });
    expect(typeof S.play[0].getNextEpisode).toBe("function");
  });
});
