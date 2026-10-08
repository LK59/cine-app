// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * Une revalidation ratée du catalogue, catalogue en main (AUDIT A6, 29/09/2026).
 *
 * SWR garde la donnée quand une revalidation échoue et pose l'erreur à côté : `data` et `error`
 * sont vrais ensemble — un redéploiement pendant `revalidateOnReconnect`, ou un lancement depuis
 * le catalogue gardé sur l'appareil pendant que le proxy répond 502. Le bureau testait l'erreur
 * seule et remplaçait tout l'écran par le message : accueil et fiches ouvertes démontés, alors que
 * le téléphone gardait ses rangées sous une ligne d'erreur. DECISIONS.md §37.
 */

const film = (radarrId: number, title: string) => ({
  radarrId,
  jellyfinItemId: `jf-${radarrId}`,
  tmdbId: 1000 + radarrId,
  title,
  year: 2000,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  posterTextlessUrl: null,
  overview: null,
  imdbRating: null,
  runtimeMinutes: null,
  genres: ["Drame"],
  addedAt: null,
});
const F1 = film(1, "Premier");
const F2 = film(2, "Deuxième");

const moviesPayload = {
  genres: ["Drame"],
  rows: { Drame: [F1, F2] },
  spotlight: [F1, F2],
  recentlyAdded: [],
  top10: [],
  top10Theme: null,
};

/** Ce que rend SWR pour le catalogue des films : réglé par chaque test. */
const catalogue: { data: unknown; error: unknown } = { data: undefined, error: undefined };

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key === "/api/cinema/movies") return { ...catalogue, isLoading: false };
    return { data: undefined, error: undefined, isLoading: false };
  },
  mutate: vi.fn(),
  preload: vi.fn(),
  useSWRConfig: () => ({ cache: new Map(), mutate: vi.fn() }),
}));

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "closed", play: vi.fn() }) }));
vi.mock("@/lib/useWarmSeriesCatalogue", () => ({ useWarmSeriesCatalogue: () => false }));
vi.mock("@/lib/useCinemaMyList", () => ({ useCinemaMyList: () => [], useCinemaMyListPending: () => false }));
vi.mock("@/lib/useIsMobile", () => ({ useIsTouch: () => false, useIsMobile: () => false }));
vi.mock("@/lib/cinemaWarmup", () => ({ prefetchImages: () => () => {}, prefetchInChunks: () => () => {}, warmUpUrls: () => [] }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => <span /> }));
vi.mock("@/components/cinema/CinemaHero", () => ({
  CinemaHero: ({ item }: { item: { title: string } }) => <p data-testid="hero">{item.title}</p>,
  HeroBannerControls: () => null,
}));
vi.mock("@/components/cinema/CinemaSeriesHero", () => ({ CinemaSeriesHero: () => null }));
vi.mock("@/components/cinema/CinemaMovieDetail", () => ({ CinemaMovieDetail: () => null }));
vi.mock("@/components/cinema/CinemaSeriesDetail", () => ({ CinemaSeriesDetail: () => null }));
vi.mock("@/components/cinema/CinemaBrowseSheet", () => ({ CinemaBrowseSheet: () => null }));

import { CinemaClient } from "@/components/cinema/CinemaClient";
import { catalogueErrorView } from "@/lib/swr";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // jsdom ne fait pas défiler : ces méthodes n'existent pas sur ses éléments.
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollBy = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  catalogue.data = undefined;
  catalogue.error = undefined;
});

describe("catalogueErrorView", () => {
  const err = new Error("Erreur 502");
  it("pas d'erreur : rien", () => {
    expect(catalogueErrorView(undefined, undefined)).toBeNull();
    expect(catalogueErrorView(undefined, moviesPayload)).toBeNull();
  });
  it("erreur sans donnée : l'écran plein", () => {
    expect(catalogueErrorView(err, undefined)).toBe("plein");
  });
  it("erreur avec donnée : une ligne, l'écran reste", () => {
    expect(catalogueErrorView(err, moviesPayload)).toBe("ligne");
  });
});

describe("le bureau, catalogue en main et revalidation en échec", () => {
  it("garde l'accueil rendu, avec une ligne d'erreur", () => {
    catalogue.data = moviesPayload;
    catalogue.error = new Error("Erreur 502");
    render(<CinemaClient />);
    expect(screen.getByTestId("hero").textContent).toBe("Premier");
    expect(document.querySelectorAll("[data-tv-card]").length).toBeGreaterThan(0);
    expect(screen.getByText("Erreur 502")).toBeTruthy();
  });

  it("sans catalogue, l'erreur prend tout l'écran", () => {
    catalogue.error = new Error("Erreur 502");
    render(<CinemaClient />);
    expect(screen.queryByTestId("hero")).toBeNull();
    expect(screen.getByText("Erreur 502")).toBeTruthy();
  });
});
