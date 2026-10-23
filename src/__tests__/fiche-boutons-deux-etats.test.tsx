// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Les boutons « À voir » et « Vu » des fiches de titre, regardés rendus plutôt que lus dans la source.
 *
 * Deux règles étaient tenues par des expressions sur le texte des fichiers, qui supposaient que
 * chaque fiche écrivait elle-même son bouton :
 *  * le glyphe qui confirme le geste (`ToggleGlyph`, 23/09/2026) — `ToggleGlyph.test.tsx` cherchait
 *    `<ToggleGlyph on={` dans chaque fiche ;
 *  * « À voir » n'est proposé qu'à un titre qui a un identifiant TMDB (`canJoinWatchlist`, §6 bis) —
 *    `decisions-partagees.test.ts` cherchait `{listable && (<button …` dans chaque fiche.
 * Les mêmes règles, sur ce que voit la personne : chaque bouton porte le glyphe ; sans identifiant
 * TMDB, pas de bouton « À voir » ; avec, il est là.
 */
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
let mobile = false;
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => mobile, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/usePlayerTitleActions", () => ({
  usePlayerTitleActions: () => ({ busy: false, setStatus: vi.fn(), request: vi.fn(), cancelRequest: vi.fn() }),
}));
vi.mock("@/lib/useTitleWatched", () => ({ useTitleWatched: () => ({ watched: false, busy: false, toggle: vi.fn() }) }));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: undefined, watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [], seasonOf: () => undefined }) }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null, similarRowKeyNav: () => false }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
const TITLE = {
  tmdbId: 2,
  type: "movie",
  title: "Matchbox",
  year: 2026,
  releaseDate: "2026-10-10",
  overview: "",
  tagline: null,
  poster: null,
  backdrop: null,
  genres: [],
  runtime: 100,
  rating: 7,
  cast: [],
  libraryId: null,
  requestState: null,
  watchlistStatus: null,
  downloading: null,
  watched: false,
  posterPath: null,
  logo: null,
};
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (key: string) => (key.startsWith("/api/player/title/") ? TITLE : new Promise(() => {})),
}));

import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { PlayerDiscoverSheet } from "@/components/player/PlayerDiscoverSheet";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const movie = (tmdbId: number | null) =>
  ({ radarrId: 3, tmdbId, jellyfinItemId: "a".repeat(32), title: "Un film", year: 1973, posterUrl: null, backdropUrl: null, logoUrl: null, genres: [] }) as unknown as CinemaMovie;
const series = (tmdbId: number | null) =>
  ({ sonarrId: 7, tmdbId, jellyfinItemId: "b".repeat(32), title: "Une série", year: 1990, posterUrl: null, backdropUrl: null, logoUrl: null, genres: [] }) as unknown as CinemaSeries;

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;

/** Les libellés, toutes fiches confondues, des deux boutons à deux états. */
const LIST = /^(watchlist\.statuses\.toWatch|cinema\.inMyList|player\.discover\.addToList|player\.discover\.inList)$/;
const SEEN = /^(cinema\.markWatched|cinema\.watchedState|player\.discover\.markWatched|player\.discover\.watched)$/;
const buttons = (re: RegExp) => Array.from(document.body.querySelectorAll("button")).filter((b) => re.test((b.textContent ?? "").trim()));

beforeEach(() => {
  mobile = false;
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const LIBRARY = [
  ["la fiche film du bureau", false, (id: number | null) => <CinemaMovieDetail item={movie(id)} onClose={vi.fn()} />],
  ["la fiche série du bureau", false, (id: number | null) => <CinemaSeriesDetail item={series(id)} onClose={vi.fn()} />],
  ["la fiche film du téléphone", true, (id: number | null) => <CinemaMobileDetail item={movie(id)} mediaType="movies" onClose={vi.fn()} />],
  ["la fiche série du téléphone", true, (id: number | null) => <CinemaMobileDetail item={series(id)} mediaType="series" onClose={vi.fn()} />],
] as const;

describe.each(LIBRARY)("%s", (_name, isPhone, draw) => {
  it("« À voir » et « Vu » portent le glyphe qui confirme le geste", () => {
    mobile = isPhone;
    render(withSwr(draw(603)));
    const toggles = [...buttons(LIST), ...buttons(SEEN)];
    expect(toggles).toHaveLength(2);
    for (const b of toggles) expect(b.querySelector("[data-toggle-glyph]")).not.toBeNull();
  });

  it("« À voir » n'est proposé qu'avec un identifiant TMDB", () => {
    mobile = isPhone;
    const { unmount } = render(withSwr(draw(null)));
    expect(buttons(LIST)).toHaveLength(0);
    unmount();
    render(withSwr(draw(0)));
    expect(buttons(LIST)).toHaveLength(0);
    expect(buttons(SEEN)).toHaveLength(1);
  });
});

describe.each([
  ["la fiche TMDB du bureau", false],
  ["la fiche TMDB du téléphone", true],
] as const)("%s", (_name, isPhone) => {
  it("« À voir » et « Vu » portent le glyphe qui confirme le geste", async () => {
    mobile = isPhone;
    render(withSwr(<PlayerDiscoverSheet tmdbId={2} mediaType="movie" />));
    await screen.findByRole("heading", { level: 1, name: "Matchbox" });
    const toggles = [...buttons(LIST), ...buttons(SEEN)];
    expect(toggles).toHaveLength(2);
    for (const b of toggles) expect(b.querySelector("[data-toggle-glyph]")).not.toBeNull();
  });
});
