// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Les fiches du bureau et l'ouverture depuis une affiche (DECISIONS.md §61) : la carte touchée
 * devient le visuel plein écran, la fiche y retourne — la même décision (`useSheetMorph`) pour le
 * film et la série, et rien de cela sans appui récent (une adresse ouverte par un lien).
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
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], seasonOf: () => undefined }) }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
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
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaMovieDetail } from "@/components/cinema/CinemaMovieDetail";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { forgetPress } from "@/lib/sheetMorph/source";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";
import { clearMorphLayers, installFakeAnimations } from "./helpers/fakeAnimations";

const MOVIE = {
  radarrId: 3,
  tmdbId: 99,
  jellyfinItemId: "jfm",
  title: "Un film",
  year: 1973,
  posterUrl: null,
  backdropUrl: "https://img.test/film-bd.jpg",
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
  backdropUrl: "https://img.test/serie-bd.jpg",
  logoUrl: null,
  genres: [],
} as unknown as CinemaSeries;

const withSwr = (node: React.ReactNode) => <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>;

let fake: ReturnType<typeof installFakeAnimations>;

function pressCard(): HTMLButtonElement {
  const card = document.createElement("button");
  const img = document.createElement("img");
  img.src = "https://img.test/affiche.jpg";
  card.appendChild(img);
  document.body.appendChild(card);
  fireEvent.pointerDown(img, { pointerId: 1, clientX: 5, clientY: 5 });
  fireEvent.pointerUp(img, { pointerId: 1, clientX: 5, clientY: 5 });
  return card;
}

beforeEach(() => {
  // `performance` figé : un appui ne vaut source que 1,2 s (`PRESS_FRESH_MS`), et monter une fiche
  // juste après l'appui en prenait davantage sous la charge de plusieurs suites en parallèle — la
  // fiche s'ouvrait alors, à raison, sans trajet, et le test lisait une fiche opaque (10/10/2026).
  // Les minuteries restent réelles.
  vi.useFakeTimers({ toFake: ["performance"] });
  fake = installFakeAnimations();
  forgetPress();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  clearMorphLayers();
  fake.restore();
  document.body.innerHTML = "";
});

const sheets = [
  ["le film", () => <CinemaMovieDetail item={MOVIE} onClose={vi.fn()} />, MOVIE.backdropUrl],
  ["la série", () => <CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />, SERIES.backdropUrl],
] as const;

/**
 * Un iPad : pas de survol, un écran large. La fiche du bureau y garde l'affiche qui devient le
 * visuel ; sur un ordinateur (jsdom sans `matchMedia` en est un), c'est la continuité du fond —
 * voir `sheetMorph-continuity.test.tsx`.
 */
function asIpad(): () => void {
  const before = window.matchMedia;
  window.matchMedia = ((media: string) =>
    ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList) as typeof window.matchMedia;
  return () => {
    window.matchMedia = before;
  };
}

describe.each(sheets)("la fiche du bureau : %s", (_name, sheet, backdrop) => {
  it("sur l'iPad, part de l'affiche touchée : pas de fondu d'entrée, la fiche transparente le temps du trajet", () => {
    const undo = asIpad();
    const card = pressCard();
    render(withSwr(sheet()));
    const root = document.body.querySelector<HTMLElement>("[data-sheet-morph-root]")!;
    expect(root.className).not.toContain("animate-fade-in");
    expect(root.style.backgroundColor).toBe("transparent");
    expect(card.style.opacity).toBe("0");
    const layer = document.body.querySelector<HTMLElement>("[data-sheet-morph-layer]")!;
    expect(layer.nextElementSibling).toBe(root);
    expect(Array.from(layer.querySelectorAll("img")).map((i) => i.getAttribute("src"))).toEqual(
      expect.arrayContaining(["https://img.test/affiche.jpg", backdrop])
    );
    // Les voiles voyagent avec le visuel, et le flou localisé attend que tout soit posé.
    expect(root.querySelectorAll("[data-sheet-veil]").length).toBe(2);
    expect(root.querySelector<HTMLElement>("[data-sheet-settle]")!.style.visibility).toBe("hidden");
    undo();
  });

  it("se ferme par Échap en rendant l'adresse : une copie s'efface, la vraie fiche se cache", () => {
    pressCard();
    const onClose = vi.fn();
    const draw = sheet();
    render(withSwr({ ...draw, props: { ...draw.props, onClose } }));
    fireEvent.keyDown(window, { key: "Escape" });
    const root = document.body.querySelector<HTMLElement>("[data-sheet-morph-root]")!;
    expect(root.style.visibility).toBe("hidden");
    expect(document.body.querySelector("[data-sheet-morph-layer] .sheet-morph-clone")).not.toBeNull();
  });

  it("sans appui récent (un lien, un rechargement) : l'entrée d'avant, rien ne vole", () => {
    render(withSwr(sheet()));
    const root = document.body.querySelector<HTMLElement>("[data-sheet-morph-root]")!;
    expect(root.className).toContain("animate-fade-in");
    expect(document.body.querySelector("[data-sheet-morph-layer]")).toBeNull();
  });
});
