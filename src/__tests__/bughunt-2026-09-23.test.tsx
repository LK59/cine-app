// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "fs";

// La chasse aux bugs du cinéma, 23/09/2026 : ce qui n'avait pas encore de test à soi.

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("rememberTitle", () => {
  it("garde « Alien » quand on ouvre « Alien: Romulus »", async () => {
    const { rememberTitle, recentSearches } = await import("@/lib/recentSearches");
    rememberTitle("Alien");
    rememberTitle("Alien: Romulus");
    expect(recentSearches()).toEqual(["Alien: Romulus", "Alien"]);
  });

  it("enregistre « Dune » même si « Dune: Part Two » est déjà là", async () => {
    const { rememberTitle, recentSearches } = await import("@/lib/recentSearches");
    rememberTitle("Dune: Part Two");
    rememberTitle("Dune");
    expect(recentSearches()).toEqual(["Dune", "Dune: Part Two"]);
  });

  it("remplace le fragment tapé pour trouver le titre", async () => {
    const { rememberSearch, rememberTitle, recentSearches } = await import("@/lib/recentSearches");
    rememberSearch("Le retour de");
    rememberTitle("Le Retour du roi", "Le retour de");
    expect(recentSearches()).toEqual(["Le Retour du roi"]);
  });
});

describe("orderSeasons", () => {
  it("met les épisodes spéciaux en dernier et ouvre sur la saison 1", async () => {
    const { orderSeasons, defaultSeason, missingCount } = await import("@/lib/seasonOrder");
    expect(orderSeasons([0, 2, 1, 3])).toEqual([1, 2, 3, 0]);
    expect(defaultSeason([0, 1, 2])).toBe(1);
    expect(defaultSeason([0])).toBe(0);
    // La pastille ne compte que ce qui manque — pas ce qui n'est pas encore sorti.
    expect(missingCount({ episodes: [{ released: true }, { released: false }, { released: false }] })).toBe(1);
  });
});

describe("browseTitles — la recherche de la grille", () => {
  it("ignore les accents, et trouve le titre de Radarr qu'on n'affiche plus", async () => {
    const { browseTitles, DEFAULT_FILTERS } = await import("@/lib/cinemaBrowse");
    const items = [
      { title: "L'Élève Ducobu", year: 2011, genres: [], addedAt: null, imdbRating: null },
      { title: "Le Prénom", aka: "What's in a Name", year: 2012, genres: [], addedAt: null, imdbRating: null },
    ];
    expect(browseTitles(items, { ...DEFAULT_FILTERS, query: "eleve" }).map((i) => i.title)).toEqual(["L'Élève Ducobu"]);
    expect(browseTitles(items, { ...DEFAULT_FILTERS, query: "what's in" }).map((i) => i.title)).toEqual(["Le Prénom"]);
  });
});

describe("ActionSheet", () => {
  it("prend le focus à l'ouverture, et garde son en-tête pendant sa sortie", async () => {
    vi.useFakeTimers();
    const { ActionSheet } = await import("@/components/ActionSheet");
    const actions = [{ label: "Retirer", onClick: vi.fn() }];
    const { rerender } = render(<ActionSheet open onClose={vi.fn()} title="Dune" actions={actions} />);
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(document.activeElement?.textContent).toContain("Retirer");
    rerender(<ActionSheet open={false} onClose={vi.fn()} title={undefined} actions={actions} />);
    expect(screen.getByText("Dune")).toBeTruthy();
    vi.useRealTimers();
  });
});

describe("useLongPress", () => {
  it("un clic droit ne laisse pas un appui long avaler le clic suivant", async () => {
    const { useLongPress } = await import("@/lib/useLongPress");
    const onMenu = vi.fn();
    const onClick = vi.fn();
    function Card() {
      const handlers = useLongPress(onMenu);
      return (
        <button {...handlers} onClick={onClick}>
          carte
        </button>
      );
    }
    render(<Card />);
    const card = screen.getByText("carte");
    fireEvent.contextMenu(card);
    expect(onMenu).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(card, { pointerType: "mouse", button: 0 });
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("le clic qui suit un appui long ouvert par `contextmenu` est avalé (Android)", async () => {
    const { useLongPress } = await import("@/lib/useLongPress");
    const onClick = vi.fn();
    function Card() {
      const handlers = useLongPress(vi.fn());
      return (
        <button {...handlers} onClick={onClick}>
          carte
        </button>
      );
    }
    render(<Card />);
    const card = screen.getByText("carte");
    fireEvent.pointerDown(card, { pointerType: "touch", clientX: 0, clientY: 0 });
    fireEvent.contextMenu(card);
    fireEvent.click(card);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("les décisions qui ne se voient qu'à la lecture du code", () => {
  const lire = (f: string) => readFileSync(f, "utf8");
  it("le menu de « Reprendre » compte dans « la grille est-elle dessus ? »", () => {
    expect(lire("src/components/cinema/CinemaClient.tsx")).toMatch(/gridIsTop\(route, playback\.mode\) && resumeMenu === null/);
  });
  it("les rangées reçoivent une fonction « Voir tout » stable", () => {
    expect(lire("src/components/cinema/CinemaClient.tsx")).not.toMatch(/onSeeAll=\{\(\) =>/);
  });
  it("la bannière du téléphone s'arrête sous la grille complète et les fiches TMDB ou personne", () => {
    const src = lire("src/components/cinema/mobile/CinemaMobileClient.tsx");
    expect(src).toMatch(/route\.browse !== null \|\|\s*route\.discover !== null \|\|\s*route\.person !== null/);
    expect(src).toMatch(/resumeFor=\{resumeFor\}/);
  });
});

// Sur le téléphone, « Titres similaires » et la saga suivaient les épisodes à venir sans écart.
describe("la fiche du téléphone espace ses rangées du bas", () => {
  it("saga et titres similaires ont leur marge", () => {
    const src = readFileSync("src/components/cinema/mobile/CinemaMobileDetail.tsx", "utf8");
    expect(src).toMatch(/<CinemaMovieCollectionRow[^>]*className="mt-8"/);
    expect(src).toMatch(/<CinemaSimilarRow[^>]*className="mt-8"/);
  });
});
