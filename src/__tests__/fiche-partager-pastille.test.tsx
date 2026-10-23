// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La pastille « Partager » d'une fiche (audit des fiches, 23/10/2026, V6).
 *
 * On partage un film, ou une série entière (§112). La fiche du téléphone cachait la pastille d'une
 * série dès que l'épisode « À suivre » avait perdu son fichier — la condition recopiée de la fiche
 * film —, la fiche série du bureau la gardait. Une règle, `shareableFrom` : un film introuvable ne se
 * partage pas, une série toujours.
 */
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }) }));
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
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false, useIsTouch: () => false }));
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
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null, similarRowKeyNav: () => false }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
vi.mock("@/lib/useRole", () => ({ useRole: () => ({ isReadOnly: false, role: "admin", jfId: null, jfUser: null }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
// L'élément que Lire lancerait — l'épisode « À suivre », ou le film — a perdu son fichier.
const MISSING = "e".repeat(32);
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: (id: string | null | undefined) => id === MISSING }));

import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { shareableFrom } from "@/components/share/ShareControl";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

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
  // Le S1·É1 que le catalogue connaît : c'est lui que Lire lancerait, et son fichier manque.
  firstEpisode: { itemId: MISSING, runtimeTicks: 3e10 },
} as unknown as CinemaSeries;
const MOVIE_MISSING = {
  radarrId: 3,
  tmdbId: 99,
  jellyfinItemId: MISSING,
  title: "Un film",
  year: 1973,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaMovie;

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;
const pill = () => document.body.querySelector('button[aria-label="share.admin.button"]');

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("la pastille Partager", () => {
  it("d'une série au téléphone reste là quand l'épisode à suivre a perdu son fichier", () => {
    render(withSwr(<CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />));
    expect(pill()).not.toBeNull();
  });

  it("d'une série au bureau aussi", () => {
    render(withSwr(<CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />));
    expect(pill()).not.toBeNull();
  });

  it("d'un film introuvable n'est pas proposée", () => {
    render(withSwr(<CinemaMobileDetail item={MOVIE_MISSING} mediaType="movies" onClose={vi.fn()} />));
    expect(pill()).toBeNull();
  });

  it("la règle : un film lisible, une série toujours, rien sans élément Jellyfin", () => {
    expect(shareableFrom("movie", { jellyfinItemId: "x", fileMissing: false })).toBe(true);
    expect(shareableFrom("movie", { jellyfinItemId: "x", fileMissing: true })).toBe(false);
    expect(shareableFrom("series", { jellyfinItemId: "x", fileMissing: true })).toBe(true);
    expect(shareableFrom("series", { jellyfinItemId: "", fileMissing: false })).toBe(false);
    expect(shareableFrom("movie", { jellyfinItemId: null, fileMissing: false })).toBe(false);
  });
});
