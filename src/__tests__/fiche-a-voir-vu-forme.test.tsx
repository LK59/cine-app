// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";

/**
 * « À voir » et « Vu » : une forme sur toutes les fiches de titre (audit des fiches, 23/10/2026, V3).
 *
 * Dans une rangée de saga ou une filmographie, un titre possédé ouvre la fiche de bibliothèque et un
 * titre absent la fiche TMDB, sans que rien dans le geste dise laquelle. Les deux mêmes gestes y
 * changeaient de mots (« À voir » / « Ajouter à ma liste »), d'icônes (plus / marque-page ; coche /
 * œil), de place (le bureau : Vu puis À voir ; la fiche TMDB : la liste puis Vu) et de message
 * (« Ajouté à ma liste » / « Ajouté à « Ma liste » »). Et le bouton « Vu » éteint du bureau disait
 * « Vu », comme allumé. Les phrases sont celles du vrai dictionnaire français.
 */
const t = createT(fr as Record<string, unknown>, fr as Record<string, unknown>, "fr");
vi.mock("@/components/TranslationProvider", () => ({ useT: () => t, useLocale: () => ({ locale: "fr", setLocale: async () => {} }) }));
let mobile = false;
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => mobile, useIsShortViewport: () => false, useIsTouch: () => false }));
const toasts = vi.hoisted(() => ({ success: [] as string[] }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ info: () => {}, success: (m: string) => toasts.success.push(m), error: () => {} }) }));
vi.mock("@/lib/apiAction", () => ({ apiAction: async () => ({}) }));
vi.mock("@/lib/usePlayerTitleActions", () => ({
  usePlayerTitleActions: () => ({ busy: false, setStatus: vi.fn(), request: vi.fn(), cancelRequest: vi.fn() }),
}));
let tmdbWatched = false;
vi.mock("@/lib/useTitleWatched", () => ({ useTitleWatched: () => ({ watched: tmdbWatched, busy: false, toggle: vi.fn() }) }));
let libraryWatched = false;
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: undefined, watched: libraryWatched, known: true, busy: false, toggleWatched: vi.fn() }),
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
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

const TITLE = {
  tmdbId: 2,
  type: "movie",
  title: "Matchbox",
  year: 2026,
  releaseDate: "2026-10-10",
  overview: "Des petites voitures.",
  tagline: null,
  poster: null,
  backdrop: null,
  genres: [],
  runtime: 100,
  rating: 7,
  cast: [],
  libraryId: null,
  requestState: null,
  watchlistStatus: null as string | null,
  downloading: null,
  watched: false,
  posterPath: null,
  logo: null,
};
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (key: string) => (key.startsWith("/api/player/title/") ? TITLE : new Promise(() => {})),
}));

import { PlayerDiscoverSheet } from "@/components/player/PlayerDiscoverSheet";
import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const MOVIE = {
  radarrId: 3,
  tmdbId: 99,
  jellyfinItemId: "a".repeat(32),
  title: "Un film",
  year: 1973,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaMovie;

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;

/** Les boutons « À voir » et « Vu » d'une fiche, dans l'ordre : libellé, icône, état annoncé. */
function toggles() {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"))
    .filter((b) => /À voir|Dans ma liste|Vu|Marquer comme vu|Ajouter à ma liste/.test(b.textContent ?? ""))
    .map((b) => ({
      label: (b.textContent ?? "").trim(),
      icon: b.querySelector("[data-toggle-glyph] svg")?.getAttribute("class")?.match(/lucide-([a-z-]+)/g)?.find((c) => c !== "lucide-icon") ?? null,
      pressed: b.getAttribute("aria-pressed"),
    }));
}

beforeEach(() => {
  mobile = false;
  tmdbWatched = false;
  libraryWatched = false;
  TITLE.watchlistStatus = null;
  toasts.success.length = 0;
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const OFF_DESKTOP = [
  { label: "Marquer comme vu", icon: "lucide-check", pressed: "false" },
  { label: "À voir", icon: "lucide-plus", pressed: "false" },
];

describe("la forme de « À voir » et « Vu »", () => {
  it("bureau, fiche de bibliothèque : Vu puis À voir, et « Vu » éteint ne dit pas « Vu »", () => {
    render(withSwr(<CinemaMovieDetail item={MOVIE} onClose={vi.fn()} />));
    expect(toggles()).toEqual(OFF_DESKTOP);
  });

  it("bureau, fiche de bibliothèque allumée : « Vu », « Dans ma liste »", () => {
    libraryWatched = true;
    render(withSwr(<CinemaMovieDetail item={MOVIE} onClose={vi.fn()} />));
    expect(toggles()[0]).toEqual({ label: "Vu", icon: "lucide-circle-check", pressed: "true" });
  });

  it("bureau, fiche TMDB : la même forme, au même ordre", async () => {
    render(withSwr(<PlayerDiscoverSheet tmdbId={2} mediaType="movie" />));
    await screen.findByRole("heading", { level: 1, name: "Matchbox" });
    expect(toggles()).toEqual(OFF_DESKTOP);
  });

  it("bureau, fiche TMDB allumée : « Vu », « Dans ma liste »", async () => {
    tmdbWatched = true;
    TITLE.watchlistStatus = "to_watch";
    render(withSwr(<PlayerDiscoverSheet tmdbId={2} mediaType="movie" />));
    await screen.findByRole("heading", { level: 1, name: "Matchbox" });
    expect(toggles()).toEqual([
      { label: "Vu", icon: "lucide-circle-check", pressed: "true" },
      { label: "Dans ma liste", icon: "lucide-bookmark-check", pressed: "true" },
    ]);
  });

  it("téléphone : À voir puis Vu, sur la fiche de bibliothèque comme sur la fiche TMDB", async () => {
    mobile = true;
    const phone = [
      { label: "À voir", icon: "lucide-plus", pressed: "false" },
      { label: "Marquer comme vu", icon: "lucide-check", pressed: "false" },
    ];
    const { unmount } = render(withSwr(<CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} />));
    expect(toggles()).toEqual(phone);
    unmount();
    document.body.innerHTML = "";
    render(withSwr(<PlayerDiscoverSheet tmdbId={2} mediaType="movie" />));
    await screen.findByRole("heading", { level: 1, name: "Matchbox" });
    expect(toggles()).toEqual(phone);
  });

  it("le même message à l'ajout depuis la fiche TMDB que depuis la bibliothèque", async () => {
    render(withSwr(<PlayerDiscoverSheet tmdbId={2} mediaType="movie" />));
    await screen.findByRole("heading", { level: 1, name: "Matchbox" });
    const add = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === "À voir")!;
    await act(async () => {
      fireEvent.click(add);
    });
    expect(toasts.success).toEqual(["Ajouté à ma liste"]);
  });
});
