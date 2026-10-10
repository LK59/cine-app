// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * Ce qui est sous la ligne de flottaison de la fiche du téléphone attend que l'ouverture soit posée.
 *
 * Mesuré le 10/10/2026 (Chromium, iPhone 13, processeur ×4) : entre l'appui sur une affiche et la
 * fiche montée, une tâche de 80 à 220 ms — la saga, les titres similaires et les épisodes mis en page
 * dans la même image que l'appui, que la mesure de départ du trajet forçait. Rien de cela n'est à
 * l'écran pendant l'ouverture.
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
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ watched: false, known: true, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [] }) }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => <div data-testid="similaires" /> }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => <div data-testid="saga" /> }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { clearMorphLayers, installFakeAnimations } from "./helpers/fakeAnimations";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";

const MOVIE = {
  radarrId: 1,
  tmdbId: 603,
  jellyfinItemId: "jf1",
  title: "Matrix",
  year: 1999,
  posterUrl: null,
  backdropUrl: "https://img.test/matrix-bd.jpg",
  logoUrl: null,
  genres: [],
  imdbRating: null,
} as unknown as CinemaMovie;

const draw = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CinemaMobileDetail item={MOVIE} mediaType="movies" onClose={vi.fn()} onSelectSimilar={vi.fn()} />
    </SWRConfig>
  );
const below = () => ({
  saga: !!document.body.querySelector('[data-testid="saga"]'),
  similar: !!document.body.querySelector('[data-testid="similaires"]'),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  clearMorphLayers();
  vi.useRealTimers();
});

describe("CinemaMobileDetail — le bas de la fiche pendant l'ouverture", () => {
  it("ouverte depuis une affiche (le trajet mène l'entrée), le bas n'arrive qu'une fois l'ouverture posée", () => {
    const fake = installFakeAnimations();
    try {
      const card = document.createElement("button");
      const img = document.createElement("img");
      img.src = "https://img.test/matrix.jpg";
      card.appendChild(img);
      document.body.appendChild(card);
      fireEvent.pointerDown(img, { pointerId: 1, clientX: 5, clientY: 5 });
      fireEvent.pointerUp(img, { pointerId: 1, clientX: 5, clientY: 5 });
      draw();
      expect(below()).toEqual({ saga: false, similar: false });
      act(() => vi.advanceTimersByTime(500));
      expect(below()).toEqual({ saga: true, similar: true });
      card.remove();
    } finally {
      fake.restore();
    }
  });

  it("sans trajet (lien, retour, mouvement réduit), tout est là d'emblée, comme avant", () => {
    draw();
    expect(below()).toEqual({ saga: true, similar: true });
  });
});
