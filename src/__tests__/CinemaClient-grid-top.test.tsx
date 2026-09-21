// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { readFileSync } from "fs";

/**
 * La grille du bureau, et ce qui la recouvre.
 *
 * Relevé le 21/09/2026 par une revue de `CinemaClient` : six décisions dépendaient de « la
 * grille est-elle l'écran du dessus ? », et chacune avait sa propre condition. Les défauts ne se
 * voient qu'avec l'écran entier — l'adresse, l'historique, la pile des fiches et la grille — donc
 * c'est l'écran entier qu'on monte ici. Les fiches, la grille complète et les bannières sont des
 * doublures : ce qu'on vérifie, c'est le câblage de `CinemaClient`, pas elles.
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

const moviesPayload = {
  genres: ["Drame"],
  rows: { Drame: [F1, F2, F3] },
  spotlight: [F1, F2],
  recentlyAdded: [],
  top10: [],
  top10Theme: null,
};
const seriesPayload = { genres: [], rows: {}, spotlight: [], recentlyAdded: [], top10: [], top10Theme: null };

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key === "/api/cinema/movies") return { data: moviesPayload, error: undefined, isLoading: false };
    if (key === "/api/cinema/series") return { data: seriesPayload, error: undefined, isLoading: false };
    return { data: undefined, error: undefined, isLoading: false };
  },
  mutate: vi.fn(),
  preload: vi.fn(),
}));

// ---- L'environnement ------------------------------------------------------------------------

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "closed", play: vi.fn() }) }));
vi.mock("@/lib/useWarmSeriesCatalogue", () => ({ useWarmSeriesCatalogue: () => false }));
vi.mock("@/lib/useCinemaMyList", () => ({ useCinemaMyList: () => [], useCinemaMyListPending: () => false }));
vi.mock("@/lib/useIsMobile", () => ({ useIsTouch: () => false, useIsMobile: () => false }));
vi.mock("@/lib/cinemaWarmup", () => ({ prefetchImages: () => () => {}, warmUpUrls: () => [] }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => <span /> }));

// ---- Les doublures ------------------------------------------------------------------------

/** La bannière : ce qu'elle montre, pour voir si la rotation tourne. */
vi.mock("@/components/cinema/CinemaHero", () => ({
  CinemaHero: ({ item }: { item: { title: string } }) => <p data-testid="hero">{item.title}</p>,
}));
vi.mock("@/components/cinema/CinemaSeriesHero", () => ({ CinemaSeriesHero: () => null }));

/**
 * Une fiche : de quoi la refermer et ouvrir un titre similaire, depuis un bouton qui lui
 * appartient — exactement là où est le focus quand on choisit un titre similaire.
 */
vi.mock("@/components/cinema/CinemaMovieDetail", () => ({
  CinemaMovieDetail: ({
    item,
    underneath,
    onClose,
    onSelectSimilar,
  }: {
    item: { radarrId: number; title: string };
    underneath: boolean;
    onClose: () => void;
    onSelectSimilar: (m: unknown) => void;
  }) => (
    <div data-testid={`fiche-${item.radarrId}`} data-underneath={String(underneath)}>
      <button type="button" onClick={onClose}>
        fermer {item.title}
      </button>
      <button type="button" onClick={() => onSelectSimilar(item.radarrId === 1 ? F2 : F3)}>
        similaire depuis {item.title}
      </button>
    </div>
  ),
}));
vi.mock("@/components/cinema/CinemaSeriesDetail", () => ({ CinemaSeriesDetail: () => null }));

/** La grille complète : elle retient le genre pour lequel elle a été montée. */
vi.mock("@/components/cinema/CinemaBrowseSheet", () => ({
  CinemaBrowseSheet: ({ genre }: { genre: string }) => {
    const [montéePour] = useState(genre);
    return (
      <div data-testid="grille-complete" data-montee-pour={montéePour}>
        <button type="button">affiche de la grille complète</button>
      </div>
    );
  },
}));

import { CinemaClient } from "@/components/cinema/CinemaClient";
import { cinemaNavigate, openLibraryTitle, readCinemaRoute } from "@/lib/cinemaRoute";
import { openResumeTarget } from "@/lib/cinemaOpen";

// ---- Le décor ---------------------------------------------------------------------------------

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // Voir cinemaRoute.test : un `popstate` rouvre la porte du « un seul retour à la fois ».
  window.dispatchEvent(new PopStateEvent("popstate"));
  // jsdom ne fait pas défiler : ces méthodes n'existent pas sur ses éléments.
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollBy = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/** Une carte de la grille de l'accueil — pas une doublure : la vraie, avec ses `data-tv-*`. */
const gridCards = () => Array.from(document.querySelectorAll<HTMLElement>("[data-tv-card]"));
const focusIsInGrid = () => gridCards().includes(document.activeElement as HTMLElement);

/** Refermer passe par `history.back()` : l'adresse change un tour plus tard. */
async function closeTop(title: string) {
  fireEvent.click(screen.getByText(`fermer ${title}`));
  await waitFor(() => expect(screen.queryByText(`fermer ${title}`)).toBeNull());
  // L'effet qui rend le focus, et l'image qu'attendait l'ancienne version.
  await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
}

// ---- Les défauts ------------------------------------------------------------------------------

describe("les flèches ne pilotent la grille que si elle est l'écran du dessus", () => {
  // Le symptôme : dans la grille complète, une flèche envoyait le focus sur une affiche *cachée*
  // de l'accueil, et Entrée ouvrait un film que personne n'avait vu passer.
  it("pas sous la grille complète", () => {
    render(<CinemaClient />);
    act(() => cinemaNavigate({ browse: "Drame" }));
    screen.getByText("affiche de la grille complète").focus();

    press("ArrowDown");
    expect(focusIsInGrid()).toBe(false);
  });

  it("pas sous une fiche TMDB", () => {
    render(<CinemaClient />);
    act(() => cinemaNavigate({ discover: 42 }));

    press("ArrowRight");
    expect(focusIsInGrid()).toBe(false);
  });

  it("toujours, quand rien ne la recouvre", () => {
    render(<CinemaClient />);
    press("ArrowDown");
    expect(focusIsInGrid()).toBe(true);
  });

  it("la grille recouverte est inerte, et plus rien ne peut y atteindre une affiche", () => {
    render(<CinemaClient />);
    const grid = gridCards()[0].closest("[inert]");
    expect(grid).toBeNull();
    act(() => cinemaNavigate({ browse: "Drame" }));
    expect(gridCards()[0].closest("[inert]")).not.toBeNull();
  });
});

describe("« / » n'ouvre la recherche que depuis la grille", () => {
  it("pas depuis la grille complète", () => {
    render(<CinemaClient />);
    act(() => cinemaNavigate({ browse: "Drame" }));
    press("/");
    expect(readCinemaRoute().search).toBe(false);
  });

  it("pas sous une fiche TMDB", () => {
    render(<CinemaClient />);
    act(() => cinemaNavigate({ person: 7 }));
    press("/");
    expect(readCinemaRoute().search).toBe(false);
  });
});

describe("le focus rendu à la grille", () => {
  // Le symptôme : un titre similaire, ouvert depuis une fiche, faisait retenir un bouton de cette
  // fiche comme « la carte d'où l'on vient ». En refermant tout, le focus visait un bouton démonté
  // et tombait sur `<body>` : la première flèche repartait de la première affiche.
  it("revient sur la carte d'où l'on est parti, même après un titre similaire", async () => {
    render(<CinemaClient />);
    const card = gridCards().find((c) => c.getAttribute("data-tv-row") === "genre-Drame")!;
    card.focus();
    fireEvent.click(card);
    expect(screen.getByTestId("fiche-1")).toBeInTheDocument();

    const similar = screen.getByText("similaire depuis Premier");
    similar.focus();
    fireEvent.click(similar);
    expect(screen.getByTestId("fiche-2")).toBeInTheDocument();

    await closeTop("Deuxième");
    await closeTop("Premier");
    expect(document.activeElement).toBe(card);
  });

  // Le symptôme : une fiche ouverte depuis la recherche rendait, en se refermant, le focus à une
  // affiche de l'accueil — cachée sous la recherche retrouvée.
  it("pas quand la fiche refermée découvre la recherche", async () => {
    render(<CinemaClient />);
    const card = gridCards()[0];
    card.focus();
    fireEvent.click(card);
    await closeTop("Premier");
    expect(document.activeElement).toBe(card);

    act(() => cinemaNavigate({ search: true }));
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => openLibraryTitle("movie", 2));
    await closeTop("Deuxième");
    expect(readCinemaRoute().search).toBe(true);
    expect(focusIsInGrid()).toBe(false);
  });
});

describe("un titre similaire n'est pas une carte de la grille", () => {
  // Le symptôme : un film ouvert depuis « Reprendre » sur l'onglet Séries, puis un titre
  // similaire. L'onglet passait à Films, et la fiche du dessous — que la pile ne redessinait que
  // pour une entrée « films » — était démontée : le retour la remontait de zéro.
  it("garde l'onglet, et la fiche du dessous reste montée", () => {
    render(<CinemaClient />);
    act(() => cinemaNavigate({ tab: "series" }, "replace"));
    act(() => openResumeTarget("/radarr/1", () => {}));
    expect(screen.getByTestId("fiche-1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("similaire depuis Premier"));
    expect(readCinemaRoute().tab).toBe("series");
    expect(screen.getByTestId("fiche-2")).toHaveAttribute("data-underneath", "false");
    expect(screen.getByTestId("fiche-1")).toHaveAttribute("data-underneath", "true");
  });
});

describe("la bannière ne tourne pas sous ce qui la recouvre", () => {
  // Chaque tour redessinait tout l'écran, fiches ouvertes comprises — et la fenêtre du synopsis
  // reprenait alors le focus toutes les huit secondes.
  it("s'arrête sous une fiche", () => {
    vi.useFakeTimers();
    render(<CinemaClient />);
    act(() => cinemaNavigate({ film: 3 }));
    const before = screen.getByTestId("hero").textContent;
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByTestId("hero").textContent).toBe(before);
  });

  it("tourne quand rien ne la recouvre", () => {
    vi.useFakeTimers();
    render(<CinemaClient />);
    const before = screen.getByTestId("hero").textContent;
    act(() => {
      vi.advanceTimersByTime(8_100);
    });
    expect(screen.getByTestId("hero").textContent).not.toBe(before);
  });
});

describe("une autre grille complète est un autre écran", () => {
  // Règle 1 du cycle de vie des fiches : sans clé, l'instance était réutilisée, avec le filtre,
  // le tri et la décennie de la grille précédente.
  it("est remontée quand le genre change", () => {
    render(<CinemaClient />);
    act(() => cinemaNavigate({ browse: "Drame" }));
    expect(screen.getByTestId("grille-complete")).toHaveAttribute("data-montee-pour", "Drame");
    act(() => cinemaNavigate({ browse: "*" }, "replace"));
    expect(screen.getByTestId("grille-complete")).toHaveAttribute("data-montee-pour", "*");
  });
});

describe("une seule réponse à « la grille est-elle dessus ? »", () => {
  it("CinemaClient la lit dans gridIsTop, et nulle part ailleurs", () => {
    const src = readFileSync("src/components/cinema/CinemaClient.tsx", "utf8");
    expect(src).toMatch(/const gridOnTop = gridIsTop\(route, playback\.mode\)/);
    expect(src).toMatch(/useTvGridNav\(gridOnTop\)/);
    expect(src).toMatch(/useCentredCard\(rowsPaneRef, touch && gridOnTop\)/);
    // Les conditions recopiées qu'elle remplace.
    expect(src).not.toMatch(/selectedItem === null && seriesSelectedItem === null && playback\.mode/);
  });
});
