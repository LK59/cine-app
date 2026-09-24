// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCinemaRoute, cinemaNavigate, cinemaClose, openLibraryTitle, useSheetBehind, arrivedByBack, useRouteBehind, personBehind, markSheetLeaving, useSheetLeaving } from "@/lib/cinemaRoute";

beforeEach(() => {
  window.history.replaceState(null, "", "/cinema");
  // Ces tests remplacent `history.back` par une fonction vide : le retour est donc *demandé* et
  // n'arrive jamais. Or `cinemaClose` ne laisse partir qu'un retour à la fois et attend `popstate`
  // pour rouvrir la porte — c'est ce qui empêche deux fermetures simultanées de reculer de deux
  // crans. Sans cette remise à zéro, le verrou d'un test fuirait dans le suivant.
  window.dispatchEvent(new PopStateEvent("popstate"));
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
      activity: null,
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

  it("n'empile rien pour un écran déjà ouvert", () => {
    // Un doigt pressé appuie deux fois sur la même affiche. Sans garde, il fallait deux retours
    // pour sortir d'un écran ouvert une seule fois — et le premier semblait ne rien faire.
    act(() => cinemaNavigate({ film: 603 }));
    const depth = window.history.length;

    act(() => cinemaNavigate({ film: 603 }));
    act(() => cinemaNavigate({ film: 603 }));

    expect(window.history.length).toBe(depth);
    expect(window.location.hash).toBe("#film=603");
  });

  it("empile quand même dès que quelque chose change vraiment", () => {
    act(() => cinemaNavigate({ film: 603 }));
    const before = window.history.length;
    act(() => cinemaNavigate({ film: 604 }));
    expect(window.history.length).toBeGreaterThan(before);
    expect(window.location.hash).toBe("#film=604");
  });

  it("laisse un « replace » réécrire l'entrée courante à l'identique", () => {
    // Il n'empile rien par nature, et c'est le moyen le plus simple de corriger `history.state`.
    act(() => cinemaNavigate({ film: 603 }));
    const length = window.history.length;
    act(() => cinemaNavigate({ film: 603 }, "replace"));
    expect(window.history.length).toBe(length);
    expect(window.location.hash).toBe("#film=603");
  });

  it("ne recule que d'un cran quand deux écrans se ferment ensemble", () => {
    // `history.back()` ne fait rien tout de suite : il programme le retour. Deux fermetures parties
    // dans la même image — deux panneaux montés pendant une bascule, chacun écoutant Échap —
    // passaient donc toutes les deux la garde de profondeur, et un seul geste emportait deux
    // écrans. Depuis le premier de la pile, il faisait sortir du mode cinéma.
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    act(() => cinemaNavigate({ film: 1 }));

    act(() => {
      cinemaClose({ film: null });
      cinemaClose({ film: null });
      cinemaClose({ film: null });
    });

    expect(back).toHaveBeenCalledOnce();
  });

  it("rouvre la porte dès que le retour a effectivement eu lieu", () => {
    // Le verrou ne dure que le temps du vol : deux fermetures successives et volontaires doivent
    // toutes les deux aboutir, sans quoi on aurait échangé un bug contre une application figée.
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    act(() => cinemaNavigate({ film: 1 }));

    act(() => cinemaClose({ film: null }));
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
    act(() => cinemaClose({ film: null }));

    expect(back).toHaveBeenCalledTimes(2);
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
      activity: null,
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
    expect(result.current).toEqual({ film: 1, serie: null, tab: "movies", person: null });
  });

  it("carries the tab, since each one resolves only its own ids", () => {
    const { result } = renderHook(() => useRouteBehind());
    act(() => openLibraryTitle("series", 50));
    act(() => openLibraryTitle("movie", 42));
    expect(result.current).toEqual({ film: null, serie: 50, tab: "series", person: null });
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

/**
 * Un titre ne peut pas être dessiné au-dessus d'une fiche personne.
 *
 * Les plans sont une échelle fixe — grille 45, panneaux 46, fiches de titre 47, personne et
 * découverte 48 —, donc « par-dessus la fiche personne » ne se voit pas : la fiche existait, sous
 * la personne et inerte, et comme la barre du bas s'efface tant qu'une fiche est adressée,
 * l'écran restait sans navigation. Signalé le 19/09/2026.
 */
describe("openLibraryTitle — ce qui la couvre se referme", () => {
  it("referme la fiche personne d'où l'on vient", () => {
    const { result } = renderHook(() => useCinemaRoute());
    act(() => cinemaNavigate({ person: 6384 }));
    expect(result.current.person).toBe(6384);

    act(() => openLibraryTitle("movie", 42));
    expect(result.current.person).toBeNull();
    expect(result.current.film).toBe(42);
  });

  /**
   * Et l'échange ne laisse rien voir entre les deux.
   *
   * C'est `useSheetBehind` qui le dit aux fiches de titre, et c'est ce qui remplace tout ce qu'on
   * aurait pu bâtir pour garder la personne montée dessous : l'entrée qu'on recouvre portait un
   * écran, donc la sortie n'a rien à découvrir et ne s'anime pas.
   */
  it("annonce qu'un écran attend derrière, pour supprimer l'animation de sortie", () => {
    const { result } = renderHook(() => useSheetBehind());
    act(() => cinemaNavigate({ search: true }));
    act(() => cinemaNavigate({ person: 6384 }));
    expect(result.current).toBe(false); // un panneau n'est pas une fiche

    act(() => openLibraryTitle("movie", 42));
    expect(result.current).toBe(true);
  });

  // Mais une fiche de *bibliothèque* derrière reste dessinée : celle-là garde son glissement.
  it("distingue une fiche de bibliothèque derrière, qui reste montée", () => {
    const { result } = renderHook(() => useRouteBehind());
    act(() => openLibraryTitle("movie", 1));
    act(() => openLibraryTitle("movie", 2));
    expect(result.current).not.toBeNull();
    expect(personBehind(result.current)).toBeNull();
  });

  it("en fait autant pour une fiche découverte", () => {
    const { result } = renderHook(() => useCinemaRoute());
    act(() => cinemaNavigate({ discover: 693134 }));

    act(() => openLibraryTitle("series", 50));
    expect(result.current.discover).toBeNull();
    expect(result.current.serie).toBe(50);
  });

  // Et le retour y ramène : l'entrée précédente porte encore la personne. « Par-dessus » et « à sa
  // place, avec un retour qui y ramène » se voient pareil — seul le second sait s'afficher.
  it("empile plutôt que de remplacer, pour que le retour rouvre la personne", () => {
    renderHook(() => useCinemaRoute());
    act(() => cinemaNavigate({ person: 6384 }));
    const avant = window.history.state.cinemaDepth as number;

    act(() => openLibraryTitle("movie", 42));
    // Un cran de plus : l'entrée qui porte la personne est toujours là, derrière celle-ci. C'est
    // ce qui distingue « refermer » de « perdre ».
    expect(window.history.state.cinemaDepth).toBe(avant + 1);
  });

  // Ce que l'écran d'origine n'a pas à subir : la recherche et Ma liste restent ouvertes dessous.
  it("ne referme pas les panneaux, qui sont sous la fiche et non dessus", () => {
    const { result } = renderHook(() => useCinemaRoute());
    act(() => cinemaNavigate({ search: true }));
    act(() => cinemaNavigate({ person: 6384 }));

    act(() => openLibraryTitle("movie", 42));
    expect(result.current.search).toBe(true);
    expect(result.current.person).toBeNull();
  });
});

/**
 * La fiche personne appartient à la pile.
 *
 * C'était son défaut structurel : une fiche de titre recouverte est redessinée dessous à partir de
 * l'entrée d'historique — c'est ce qui donne aux « titres similaires » leur empilement net —, mais
 * la personne n'était nommée nulle part. Il n'y avait donc rien sous le film, et sa sortie
 * découvrait l'écran de recherche, deux crans plus bas.
 */
describe("personBehind", () => {
  it("nomme la personne que le film recouvre", () => {
    const { result } = renderHook(() => useRouteBehind());
    act(() => cinemaNavigate({ search: true }));
    act(() => cinemaNavigate({ person: 6384 }));
    act(() => openLibraryTitle("movie", 42));

    expect(personBehind(result.current)).toBe(6384);
  });

  // Une personne ouverte sur un film recouvre ce film : l'entrée d'en dessous est celle du film seul.
  it("ne nomme personne quand c'est un titre qui est recouvert", () => {
    const { result } = renderHook(() => useRouteBehind());
    act(() => openLibraryTitle("movie", 1));
    act(() => cinemaNavigate({ person: 6384 }));

    expect(result.current?.film).toBe(1);
    expect(personBehind(result.current)).toBeNull();
  });

  // La cascade film → acteur → film : l'entrée recouverte porte le premier film *et* l'acteur
  // posé dessus. C'est l'acteur qu'on doit retrouver en tirant le second film — pas le premier,
  // sur lequel sa carte surgissait ensuite d'un coup.
  it("nomme l'acteur posé sur un film, dans une cascade", () => {
    const { result } = renderHook(() => useRouteBehind());
    act(() => openLibraryTitle("movie", 1));
    act(() => cinemaNavigate({ person: 6384 }));
    act(() => openLibraryTitle("movie", 2));

    expect(result.current?.film).toBe(1);
    expect(personBehind(result.current)).toBe(6384);
  });

  it("ne nomme personne quand il n'y a rien derrière", () => {
    const { result } = renderHook(() => useRouteBehind());
    act(() => cinemaNavigate({ search: true }));
    act(() => openLibraryTitle("movie", 42));

    expect(personBehind(result.current)).toBeNull();
  });
});

// La barre du téléphone revient pendant que la fiche sort, et non après : le signal part au début
// de la sortie. Il doit tomber au premier changement d'adresse, sans quoi rouvrir le même titre
// plus tard le retrouverait debout — et la barre flotterait par-dessus la fiche.
describe("useSheetLeaving", () => {
  it("se lève quand une fiche commence à sortir", () => {
    cinemaNavigate({ film: 7 });
    const { result } = renderHook(() => useSheetLeaving());
    expect(result.current).toBe(false);
    act(() => markSheetLeaving());
    expect(result.current).toBe(true);
  });

  it("tombe dès que l'adresse change, et ne revient pas avec le même titre", () => {
    cinemaNavigate({ film: 7 });
    const { result } = renderHook(() => useSheetLeaving());
    act(() => markSheetLeaving());
    act(() => cinemaNavigate({ film: null }, "replace"));
    expect(result.current).toBe(false);
    act(() => cinemaNavigate({ film: 7 }));
    expect(result.current).toBe(false);
  });

  it("tombe sur un retour", () => {
    cinemaNavigate({ film: 7 });
    const { result } = renderHook(() => useSheetLeaving());
    act(() => markSheetLeaving());
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current).toBe(false);
  });
});
