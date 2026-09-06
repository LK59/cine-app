// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCinemaRoute, cinemaNavigate, cinemaClose, openLibraryTitle, useSheetBehind, arrivedByBack, useRouteBehind } from "@/lib/cinemaRoute";

beforeEach(() => {
  window.history.replaceState(null, "", "/cinema");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("cinemaRoute", () => {
  it("starts empty and reflects what the hash says", () => {
    const { result } = renderHook(() => useCinemaRoute());
    expect(result.current).toEqual({
      tab: "movies",
      film: null,
      serie: null,
      episodes: false,
      search: false,
      list: false,
      account: false,
      discover: null,
      discoverType: "movie",
      person: null,
      browse: null,
      menu: false,
    });

    act(() => cinemaNavigate({ film: 603 }));
    expect(window.location.hash).toBe("#film=603");
    expect(result.current.film).toBe(603);
  });

  it("keeps the layers it wasn't asked to change", () => {
    act(() => cinemaNavigate({ tab: "series" }, "replace"));
    act(() => cinemaNavigate({ serie: 12 }));
    act(() => cinemaNavigate({ episodes: true }));
    expect(window.location.hash).toBe("#tab=series&serie=12&episodes=1");
  });

  it("pushes a history entry for a screen and replaces for a filter", () => {
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");

    act(() => cinemaNavigate({ film: 1 }));
    expect(push).toHaveBeenCalledOnce();

    act(() => cinemaNavigate({ tab: "series" }, "replace"));
    expect(push).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
  });

  it("steps back when it opened the layer itself", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    act(() => cinemaNavigate({ film: 1 }));
    act(() => cinemaClose({ film: null }));
    expect(back).toHaveBeenCalledOnce();
  });

  it("rewrites the entry instead of leaving the app on a deep link", () => {
    // Landed straight on a title: nothing of ours behind, so stepping back would exit the app.
    window.history.replaceState(null, "", "/cinema#film=603");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});

    const { result } = renderHook(() => useCinemaRoute());
    expect(result.current.film).toBe(603);

    act(() => cinemaClose({ film: null }));
    expect(back).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(result.current.film).toBeNull();
  });

  it("ignores junk in the hash rather than opening a broken sheet", () => {
    window.history.replaceState(null, "", "/cinema#film=abc&serie=-4&tab=nope");
    const { result } = renderHook(() => useCinemaRoute());
    expect(result.current).toEqual({
      tab: "movies",
      film: null,
      serie: null,
      episodes: false,
      search: false,
      list: false,
      account: false,
      discover: null,
      discoverType: "movie",
      person: null,
      browse: null,
      menu: false,
    });
  });

  // La grille complète est une adresse comme une autre : elle se partage, et le retour ramène à
  // la rangée d'où l'on vient plutôt qu'à l'accueil.
  it("carries the browse grid in the hash, genre included", () => {
    const { result } = renderHook(() => useCinemaRoute());

    act(() => cinemaNavigate({ browse: "Science-Fiction" }));
    expect(result.current.browse).toBe("Science-Fiction");
    expect(window.location.hash).toContain("parcourir=Science-Fiction");

    act(() => cinemaNavigate({ browse: "*" }));
    expect(result.current.browse).toBe("*");

    act(() => cinemaNavigate({ browse: null }));
    expect(result.current.browse).toBeNull();
    expect(window.location.hash).not.toContain("parcourir");
  });

  it("follows Back and Forward", () => {
    const { result } = renderHook(() => useCinemaRoute());
    act(() => cinemaNavigate({ film: 7 }));
    expect(result.current.film).toBe(7);

    // What the browser does on Back: the URL changes, then popstate fires.
    act(() => {
      window.history.replaceState(null, "", "/cinema");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.film).toBeNull();
  });
});

describe("openLibraryTitle", () => {
  // L'onglet fait partie de l'adresse, et les deux écrans (films, séries) ne savent résoudre que
  // leur propre identifiant. Ouvrir une série en laissant l'onglet sur « Films » ne résolvait
  // donc rien : la fiche ne s'ouvrait pas et, le geste ayant refermé l'écran d'origine, on
  // retombait sur l'accueil. C'était le cas de tous les liens de Ma liste, de la recherche et des
  // fiches personnes.
  it("switches to the tab that can resolve the id", () => {
    act(() => openLibraryTitle("series", 50));
    expect(window.location.hash).toBe("#tab=series&serie=50");

    act(() => openLibraryTitle("movie", 42));
    expect(window.location.hash).toBe("#film=42");
  });

  it("clears the other kind's id so only one sheet can be open", () => {
    act(() => cinemaNavigate({ film: 7 }, "replace"));
    act(() => openLibraryTitle("series", 50));
    expect(window.location.hash).toBe("#tab=series&serie=50");
  });

  // Elle n'a pas à refermer l'écran d'où l'on vient : c'est ce qui permet au retour de ramener sur
  // la recherche ou sur Ma liste, avec la requête et l'onglet intacts.
  it("leaves the panel it was opened from alone", () => {
    act(() => cinemaNavigate({ search: true }, "replace"));
    act(() => openLibraryTitle("movie", 42));
    expect(window.location.hash).toContain("recherche=1");
    expect(window.location.hash).toContain("film=42");
  });
});

describe("useSheetBehind", () => {
  // Le symptôme rapporté : Accueil → Film 1 → Film 2, puis à la fermeture de Film 2 on voyait
  // « Film 2 → Accueil → Film 1 ». L'accueil n'était que l'animation de sortie de Film 2, jouée
  // avant le retour, pendant laquelle il n'y avait effectivement rien d'autre à l'écran.
  it("knows whether closing lands on another sheet or on the grid", () => {
    const { result } = renderHook(() => useSheetBehind());
    expect(result.current).toBe(false);

    act(() => openLibraryTitle("movie", 1));
    expect(result.current).toBe(false); // derrière le premier film : la grille

    act(() => openLibraryTitle("movie", 2));
    expect(result.current).toBe(true); // derrière le second : le premier
  });

  // Un `replace` ne change pas ce qu'il y a en dessous — changer d'onglet ne doit pas faire
  // croire qu'une fiche attend.
  it("is untouched by a replace", () => {
    const { result } = renderHook(() => useSheetBehind());
    act(() => openLibraryTitle("movie", 1));
    act(() => openLibraryTitle("movie", 2));
    act(() => cinemaNavigate({ tab: "series" }, "replace"));
    expect(result.current).toBe(true);
  });
});

describe("arrivedByBack", () => {
  // Un écran qui se monte parce qu'on revient dessus ne doit pas rejouer son ouverture : il
  // n'ouvre rien, il se découvre. Sans cette distinction, fermer Film 2 donnait l'impression que
  // Film 1 se rouvrait, alors qu'il n'avait jamais été fermé pour de bon.
  it("is false for a deliberate navigation and true right after a back", () => {
    act(() => openLibraryTitle("movie", 1));
    expect(arrivedByBack()).toBe(false);

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(arrivedByBack()).toBe(true);

    // Et la navigation suivante le fait retomber, sans attendre l'image d'après.
    act(() => openLibraryTitle("movie", 2));
    expect(arrivedByBack()).toBe(false);
  });
});

describe("useRouteBehind", () => {
  // Ce qu'il faut pour dessiner la fiche précédente *sous* celle qu'on tire vers le bas : sans
  // elle, le geste découvrait la grille et la précédente n'apparaissait qu'une fois l'animation
  // finie — alors que tout le mouvement dit qu'on remonte d'un cran.
  it("names the sheet the current entry covers", () => {
    const { result } = renderHook(() => useRouteBehind());
    expect(result.current).toBeNull();

    act(() => openLibraryTitle("movie", 1));
    expect(result.current).toBeNull(); // la grille, pas une fiche

    act(() => openLibraryTitle("movie", 2));
    expect(result.current).toEqual({ film: 1, serie: null, tab: "movies" });
  });

  it("carries the tab, since each one resolves only its own ids", () => {
    const { result } = renderHook(() => useRouteBehind());
    act(() => openLibraryTitle("series", 50));
    act(() => openLibraryTitle("movie", 42));
    expect(result.current).toEqual({ film: null, serie: 50, tab: "series" });
  });

  // useSyncExternalStore exige une identité stable entre deux changements ; l'objet vient de
  // history.state, recréé à chaque lecture.
  it("keeps a stable identity between changes", () => {
    const { result, rerender } = renderHook(() => useRouteBehind());
    act(() => openLibraryTitle("movie", 1));
    act(() => openLibraryTitle("movie", 2));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
