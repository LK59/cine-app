// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

/**
 * Les rangées de découverte sur les deux accueils (14/10/2026, DECISIONS.md §52).
 *
 * Le bureau posait « Recommandé pour vous » et « Tendances films » après le dernier genre, quand le
 * téléphone les montrait sous les derniers ajouts ; il n'affichait pas l'étiquette de la rangée
 * (« D'après Interstellar, Dune et Premier contact » depuis) ; et survoler ou désigner une de leurs
 * cartes vidait la bannière. On monte ici le vrai écran du bureau et les vraies rangées du téléphone, sur les mêmes données, et on compare.
 */

// ---- Les données ----------------------------------------------------------------------------

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
const F3 = film(3, "Troisième");

const serie = (sonarrId: number, title: string) => ({
  sonarrId,
  jellyfinItemId: `jfs-${sonarrId}`,
  tvdbId: 500 + sonarrId,
  tmdbId: 2000 + sonarrId,
  title,
  year: 2010,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  posterTextlessUrl: null,
  overview: null,
  imdbRating: null,
  genres: ["Comédie"],
  addedAt: null,
});
const S1 = serie(1, "Série Une");
const S2 = serie(2, "Série Deux");

const moviesPayload = {
  genres: ["Drame"],
  rows: { Drame: [F1, F2, F3] },
  spotlight: [F1, F2],
  recentlyAdded: [F3, F1],
  top10: [],
  top10Theme: null,
};
const seriesPayload = {
  genres: ["Comédie"],
  rows: { Comédie: [S1, S2] },
  spotlight: [S1],
  recentlyAdded: [S2],
  top10: [],
  top10Theme: null,
};
const disc = (tmdbId: number, type: "movie" | "series", title: string, libraryId: number | null = null) => ({
  tmdbId,
  type,
  title,
  year: 2024,
  poster: null,
  libraryId,
});
const discoverPayload = {
  rows: [
    { key: "recommended", basedOn: ["Interstellar", "Dune", "Premier contact"], items: [disc(91, "movie", "Reco absente")] },
    { key: "trendingMovies", items: [disc(92, "movie", "Tendance absente"), disc(1001, "movie", "Premier", 1)] },
    { key: "trendingSeries", items: [disc(93, "series", "Série tendance")] },
  ],
};

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key === "/api/cinema/movies") return { data: moviesPayload, error: undefined, isLoading: false };
    if (key === "/api/cinema/series") return { data: seriesPayload, error: undefined, isLoading: false };
    if (key === "/api/player/discover") return { data: discoverPayload, error: undefined, isLoading: false };
    return { data: undefined, error: undefined, isLoading: false };
  },
  mutate: vi.fn(),
  preload: vi.fn(),
  useSWRConfig: () => ({ cache: new Map(), mutate: vi.fn() }),
}));

// ---- L'environnement (celui de CinemaClient-grid-top) ----------------------------------------

// `t` rend la clé, et les variables à sa suite : l'étiquette se lit telle quelle.
const t = (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${Object.values(vars).join(",")}` : k);
vi.mock("@/components/TranslationProvider", () => ({ useT: () => t, useLocale: () => ({ locale: "fr", setLocale: () => {} }) }));
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
vi.mock("@/components/cinema/CinemaSeriesHero", () => ({
  CinemaSeriesHero: ({ item }: { item: { title: string } }) => <p data-testid="hero-series">{item.title}</p>,
}));
vi.mock("@/components/cinema/CinemaMovieDetail", () => ({ CinemaMovieDetail: () => null }));
vi.mock("@/components/cinema/CinemaSeriesDetail", () => ({ CinemaSeriesDetail: () => null }));
vi.mock("@/components/cinema/CinemaBrowseSheet", () => ({ CinemaBrowseSheet: () => null }));

import { CinemaClient } from "@/components/cinema/CinemaClient";
import { MobileTabRows } from "@/components/cinema/mobile/CinemaMobileClient";
import { cinemaNavigate, readCinemaRoute } from "@/lib/cinemaRoute";
import { discoveryEyebrow, discoveryRowsFor } from "@/lib/homeLayout";
import { createT } from "@/lib/i18n";
import frDict from "@/locales/fr.json";
import enDict from "@/locales/en.json";
import type { CinemaMoviesPayload } from "@/app/api/cinema/movies/route";
import type { CinemaSeriesPayload } from "@/app/api/cinema/series/route";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollBy = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Les rangées qui nous occupent, dans l'ordre du document : les ajouts, la découverte, les genres. */
const WATCHED = new Set([
  "cinema.recentlyAdded",
  "cinema.discovery.recommended",
  "cinema.discovery.trendingMovies",
  "cinema.discovery.trendingSeries",
  "genres.Drame",
  "genres.Comédie",
]);
function rowOrder(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll("h2"))
    // L'onglet gardé mais caché n'est pas à l'écran (`keptTabs`).
    .filter((h) => h.closest("[data-tab-hidden]") === null)
    .map((h) => h.textContent ?? "")
    // `genreLabel` traduit par une clé de genre : on ne garde que ce qui y ressemble.
    .map((label) => (label.includes("Drame") ? "genres.Drame" : label.includes("Comédie") ? "genres.Comédie" : label))
    .filter((label) => WATCHED.has(label));
}
const press = (key: string) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
const cardsOf = (row: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-tv-row="${row}"]`));

function mobileOrder(tab: "movies" | "series"): string[] {
  const { container, unmount } = render(
    <MobileTabRows
      tab={tab}
      payload={(tab === "movies" ? moviesPayload : seriesPayload) as unknown as CinemaMoviesPayload | CinemaSeriesPayload}
      myList={[]}
      myListPending={false}
      discoveryRows={discoverPayload.rows}
      onSelect={() => {}}
      onDiscover={() => {}}
    />
  );
  const order = rowOrder(container);
  unmount();
  return order;
}

// ---- La règle --------------------------------------------------------------------------------

describe("discoveryRowsFor", () => {
  it("Films : recommandé et tendances films, dans l'ordre du serveur ; Séries : tendances séries", () => {
    expect(discoveryRowsFor("movies", discoverPayload.rows).map((r) => r.key)).toEqual(["recommended", "trendingMovies"]);
    expect(discoveryRowsFor("series", discoverPayload.rows).map((r) => r.key)).toEqual(["trendingSeries"]);
    expect(discoveryRowsFor("movies", undefined)).toEqual([]);
  });

  it("l'étiquette ne vient que des titres qui expliquent la rangée", () => {
    expect(discoveryEyebrow({ basedOn: ["Interstellar"] }, t, "fr")).toBe("cinema.basedOn:Interstellar");
    expect(discoveryEyebrow({}, t, "fr")).toBeNull();
    expect(discoveryEyebrow({ basedOn: [] }, t, "fr")).toBeNull();
  });
});

// Le vrai dictionnaire, pour lire la phrase entière telle qu'elle s'affiche.
const realT = (locale: "fr" | "en") => createT(locale === "fr" ? frDict : enDict, frDict, locale);

describe("discoveryEyebrow : un, deux ou trois titres, dans la langue de l'interface", () => {
  it.each([
    ["fr", ["Interstellar"], "D'après Interstellar"],
    ["fr", ["Interstellar", "Dune"], "D'après Interstellar et Dune"],
    ["fr", ["Interstellar", "Dune", "Premier contact"], "D'après Interstellar, Dune et Premier contact"],
    ["en", ["Interstellar"], "Based on Interstellar"],
    ["en", ["Interstellar", "Dune"], "Based on Interstellar and Dune"],
    ["en", ["Interstellar", "Dune", "Arrival"], "Based on Interstellar, Dune, and Arrival"],
  ] as const)("%s : %j", (locale, titles, expected) => {
    expect(discoveryEyebrow({ basedOn: [...titles] }, realT(locale), locale)).toBe(expected);
  });

  it("une réponse d'avant gardée sur l'appareil (`becauseOf`) ne plante pas : pas d'étiquette", () => {
    expect(discoveryEyebrow({ becauseOf: "Interstellar" } as { basedOn?: unknown }, realT("fr"), "fr")).toBeNull();
    expect(discoveryEyebrow({ basedOn: "Interstellar" }, realT("fr"), "fr")).toBeNull();
    expect(discoveryEyebrow({ basedOn: [null, "", "Dune"] }, realT("fr"), "fr")).toBe("D'après Dune");
  });
});

// ---- Les deux accueils -----------------------------------------------------------------------

describe("le bureau range la découverte comme le téléphone", () => {
  it("Films : sous les derniers ajouts, avant les genres — le même ordre des deux côtés", () => {
    const phone = mobileOrder("movies");
    expect(phone).toEqual(["cinema.recentlyAdded", "cinema.discovery.recommended", "cinema.discovery.trendingMovies", "genres.Drame"]);
    render(<CinemaClient />);
    expect(rowOrder(document)).toEqual(phone);
  });

  it("Séries : « Tendances séries » existe au bureau, à la même place", () => {
    const phone = mobileOrder("series");
    expect(phone).toEqual(["cinema.recentlyAdded", "cinema.discovery.trendingSeries", "genres.Comédie"]);
    render(<CinemaClient />);
    act(() => cinemaNavigate({ tab: "series" }, "replace"));
    expect(rowOrder(document)).toEqual(phone);
    expect(cardsOf("trendingSeries")).toHaveLength(1);
  });

  it("« D'après … » s'affiche au bureau comme au téléphone, sur une ligne coupée proprement", () => {
    // `t` du test joint ses variables : la liste formatée par `Intl.ListFormat` (fr) s'y lit.
    const label = "cinema.basedOn:Interstellar, Dune et Premier contact";
    render(<CinemaClient />);
    const desktop = screen.getAllByText(label);
    expect(desktop).toHaveLength(1);
    expect(desktop[0].className).toMatch(/\btruncate\b/);
    cleanup();

    render(
      <MobileTabRows
        tab="movies"
        payload={moviesPayload as unknown as CinemaMoviesPayload}
        myList={[]}
        myListPending={false}
        discoveryRows={discoverPayload.rows}
        onSelect={() => {}}
        onDiscover={() => {}}
      />
    );
    const phone = screen.getAllByText(label);
    expect(phone).toHaveLength(1);
    expect(phone[0].className).toMatch(/\btruncate\b/);
  });

  it("une réponse d'avant gardée sur l'appareil (`becauseOf`) s'affiche sans étiquette", () => {
    const rows = discoverPayload.rows;
    discoverPayload.rows = rows.map((r) => (r.key === "recommended" ? { key: r.key, becauseOf: "Interstellar", items: r.items } : r)) as typeof rows;
    try {
      render(<CinemaClient />);
      expect(screen.getAllByText("cinema.discovery.recommended")).toHaveLength(1);
      expect(screen.queryByText(/cinema\.basedOn|cinema\.becauseWatched/)).toBeNull();
    } finally {
      discoverPayload.rows = rows;
    }
  });
});

describe("une carte de découverte ne vide pas la bannière", () => {
  it("au focus, la bannière garde le dernier titre de la bibliothèque", () => {
    render(<CinemaClient />);
    const genreCard = cardsOf("genre-Drame")[1];
    act(() => genreCard.focus());
    expect(screen.getByTestId("hero").textContent).toBe("Deuxième");

    act(() => cardsOf("trendingMovies")[0].focus());
    expect(screen.getByTestId("hero").textContent).toBe("Deuxième");
    fireEvent.mouseEnter(cardsOf("recommended")[0]);
    fireEvent.mouseMove(cardsOf("recommended")[0]);
    expect(screen.getByTestId("hero").textContent).toBe("Deuxième");
  });

  it("les flèches traversent les rangées dans leur nouvel ordre, sans toucher à la bannière", () => {
    render(<CinemaClient />);
    act(() => cardsOf("recent-movies")[0].focus());
    expect(screen.getByTestId("hero").textContent).toBe("Troisième");

    press("ArrowDown");
    expect(document.activeElement?.getAttribute("data-tv-row")).toBe("recommended");
    press("ArrowDown");
    expect(document.activeElement?.getAttribute("data-tv-row")).toBe("trendingMovies");
    press("ArrowRight");
    expect(document.activeElement?.getAttribute("data-tv-row")).toBe("trendingMovies");
    expect(document.activeElement?.getAttribute("data-tv-col")).toBe("1");
    expect(screen.getByTestId("hero").textContent).toBe("Troisième");
    press("ArrowDown");
    expect(document.activeElement?.getAttribute("data-tv-row")).toBe("genre-Drame");
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowUp");
    expect(document.activeElement?.getAttribute("data-tv-row")).toBe("recent-movies");
  });

  it("l'ouverture ne change pas : la fiche TMDB pour un absent, la fiche du titre sinon", () => {
    render(<CinemaClient />);
    fireEvent.click(cardsOf("trendingMovies")[0]);
    expect(readCinemaRoute().discover).toBe(92);
  });
});
