// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

let payload: Record<string, unknown> = { library: [], tmdb: [], persons: [] };
// Une requête de recherche qui échoue — hors ligne, serveur qui redémarre.
let failing = false;
// Le module réel, dont on ne remplace que le `fetcher` : il porte aussi les clés de cache
// (`MOVIES_CATALOGUE_KEY`…) et les options que ces écrans lisent. Un mock qui n'expose que ce
// dont on se souvient les laisse valoir `undefined`.
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async () => {
    if (failing) throw new Error("Load failed");
    return payload;
  },
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr" }),
}));

/**
 * Le catalogue que l'écran a déjà en mémoire, et sur lequel il devine.
 *
 * Constant et posé avant le rendu : ces deux clés sont demandées dès le montage, contrairement à
 * celle de la recherche, qui n'existe qu'une fois qu'on a tapé.
 */
const HANNIBAL = {
  radarrId: 7, tmdbId: 1000, title: "Hannibal", year: 2001, posterUrl: null,
  genres: ["Thriller"], imdbRating: "6.8", addedAt: null,
};
vi.mock("@/lib/cinemaPayload", () => ({
  cinemaFetcher: async (url: string) =>
    url.includes("/series")
      ? { items: [], rows: {}, spotlight: [], recentlyAdded: [], top10: [] }
      : { items: [HANNIBAL], rows: { Thriller: [HANNIBAL] }, spotlight: [], recentlyAdded: [], top10: [] },
}));
vi.mock("@/components/PosterImage", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  PosterImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
const mockNavigate = vi.fn();
vi.mock("@/lib/cinemaRoute", () => ({
  cinemaNavigate: (...a: unknown[]) => mockNavigate(...a),
  cinemaClose: vi.fn(),
  openLibraryTitle: (type: string, id: number, extra: Record<string, unknown> = {}) =>
    mockNavigate(type === "series" ? { ...extra, tab: "series", serie: id, film: null } : { ...extra, tab: "movies", film: id, serie: null }),
}));
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { PlayerSearchPanel, forgetSearchQuery } from "@/components/player/PlayerSearchPanel";

const OWNED = {
  tmdbId: 603, title: "Matrix", year: 1999, posterPath: null, type: "movie",
  overview: "", rating: 8, radarrId: 42, sonarrId: null, inLibrary: true, sources: ["radarr"],
};
const OWNED_SERIES = {
  tmdbId: 1399, title: "Game of Thrones", year: 2011, posterPath: null, type: "series",
  overview: "", rating: 8, radarrId: null, sonarrId: 50, inLibrary: true, sources: ["sonarr"],
};
const MISSING = {
  tmdbId: 693134, title: "Dune", year: 2024, posterPath: null, type: "movie",
  overview: "", rating: 8, radarrId: null, sonarrId: null, inLibrary: false, sources: ["tmdb"],
};
const SHORT_FILM_HANN = {
  tmdbId: 55555, title: "Hann, Hein und Henny", year: 1917, posterPath: null, type: "movie",
  overview: "", rating: 5, radarrId: null, sonarrId: null, inLibrary: false, sources: ["tmdb"],
};
const PERSON = { id: 6384, name: "Keanu Reeves", profilePath: null, department: "Acting", knownFor: [], libraryCount: 3, libraryTitles: [] };

async function type(term: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: term } });
  await waitFor(() => expect(screen.queryByText("player.search.hint")).toBeNull(), { timeout: 2000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetSearchQuery();
  failing = false;
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlayerSearchPanel />
    </SWRConfig>
  );
});
afterEach(cleanup);

describe("PlayerSearchPanel", () => {
  it("shows owned titles, missing titles and people in one grid", async () => {
    payload = { library: [OWNED], tmdb: [MISSING], persons: [PERSON] };
    await type("matrix");

    expect(await screen.findByText("Matrix")).toBeTruthy();
    expect(screen.getByText("Dune")).toBeTruthy();
    expect(screen.getByText("Keanu Reeves")).toBeTruthy();
    // Une seule chose distingue les deux titres : la pastille sur celui qu'on n'a pas.
    expect(screen.getAllByText("player.notInLibrary")).toHaveLength(1);
  });

  // Le contrat central de cet écran : ce qu'on possède ouvre la fiche de la bibliothèque, ce
  // qu'on ne possède pas ouvre une vraie fiche où « Lire » est devenu « Demander ».
  it("routes an owned title to its library sheet and a missing one to the TMDB sheet", async () => {
    payload = { library: [OWNED], tmdb: [MISSING], persons: [] };
    await type("matrix");

    fireEvent.click(await screen.findByText("Matrix"));
    // L'onglet fait partie de l'adresse et doit suivre le type, sinon l'écran cinéma ne résout
    // pas l'identifiant et rien ne s'ouvre. Et la recherche n'est PAS refermée : la fiche passe
    // par-dessus, pour qu'un retour ramène aux résultats.
    expect(mockNavigate).toHaveBeenCalledWith({ tab: "movies", film: 42, serie: null });
    expect(mockNavigate.mock.calls[0][0]).not.toHaveProperty("search");

    fireEvent.click(screen.getByText("Dune"));
    expect(mockNavigate).toHaveBeenCalledWith({ discover: 693134, discoverType: "movie" });
  });

  // La régression même : une série ouverte depuis un écran resté sur l'onglet « Films » ne se
  // résolvait pas, donc rien ne s'ouvrait — et comme le geste refermait la recherche, on
  // retombait sur l'accueil.
  it("carries the series tab when opening a series", async () => {
    payload = { library: [OWNED_SERIES], tmdb: [], persons: [] };
    await type("game of thrones");

    fireEvent.click(await screen.findByText("Game of Thrones"));
    expect(mockNavigate).toHaveBeenCalledWith({ tab: "series", serie: 50, film: null });
  });

  it("sends a person to their own sheet", async () => {
    payload = { library: [], tmdb: [], persons: [PERSON] };
    await type("keanu");

    fireEvent.click(await screen.findByText("Keanu Reeves"));
    expect(mockNavigate).toHaveBeenCalledWith({ person: 6384 });
  });

  // Les filtres apparaissent après les résultats, jamais avant : choisir un type avant d'avoir
  // tapé oblige à savoir ce qu'on cherche, et la moitié du temps on ne le sait pas.
  it("only offers filters once there is something to filter", async () => {
    expect(screen.queryByText("player.search.filterAll")).toBeNull();

    payload = { library: [OWNED], tmdb: [], persons: [PERSON] };
    await type("matrix");

    expect(await screen.findByText("player.search.filterAll")).toBeTruthy();
    fireEvent.click(screen.getByText("player.kind.personPlural"));
    expect(screen.getByText("Keanu Reeves")).toBeTruthy();
    expect(screen.queryByText("Matrix")).toBeNull();
  });
});

describe("PlayerSearchPanel — clearing the field", () => {
  // `keepPreviousData` garde les derniers résultats quand la clé change : c'est ce qu'on veut en
  // tapant, et le contraire de ce qu'on veut en effaçant — le champ redevenait vide, l'invitation
  // réapparaissait, et la grille précédente restait affichée dessous.
  it("empties the grid when the query is cleared", async () => {
    payload = { library: [OWNED], tmdb: [], persons: [] };
    await type("matrix");
    expect(await screen.findByText("Matrix")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText("Matrix")).toBeNull());
    // Le champ vide rend l'écran de départ — les dernières recherches, ce qui vient d'arriver —
    // et non plus une phrase grise. Ce qui compte ici est que la grille de résultats et ses
    // filtres aient bien disparu.
    expect(screen.getByText("player.search.recent")).toBeTruthy();
    expect(screen.queryByText("player.search.filterAll")).toBeNull();
  });

  /**
   * La croix, et le clavier qui reste.
   *
   * `type="search"` dessine bien une croix native, mais pas sur iOS — précisément là où enchaîner
   * des recherches au pouce est le plus pénible, et d'où la demande vient. Le champ reprend le
   * focus après l'effacement : sans ça, vider la recherche referme le clavier et il faut retoucher
   * l'écran pour retaper le mot suivant.
   */
  it("offre une croix qui vide le champ et lui rend le focus", async () => {
    payload = { library: [OWNED], tmdb: [], persons: [] };
    await type("matrix");

    const clear = screen.getByLabelText("common.clear");
    fireEvent.click(clear);

    const box = screen.getByRole("searchbox") as HTMLInputElement;
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
  });

  // Rien à effacer, rien à montrer : une croix sur un champ vide est un bouton qui ne fait rien.
  it("ne montre pas de croix tant qu'il n'y a rien à effacer", () => {
    // Le panneau est monté vide par le beforeEach : rien de tapé, donc rien à effacer.
    expect(screen.queryByLabelText("common.clear")).toBeNull();
  });
});

// Ouvrir une fiche depuis les résultats puis revenir doit ramener la recherche telle quelle :
// le panneau est démonté entre les deux, donc la requête vit en dehors du composant.
describe("PlayerSearchPanel — remembering the query", () => {
  it("restores the last query after being closed and reopened", async () => {
    payload = { library: [OWNED], tmdb: [], persons: [] };
    await type("matrix");
    expect(await screen.findByText("Matrix")).toBeTruthy();

    cleanup();
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PlayerSearchPanel />
      </SWRConfig>
    );

    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("matrix");
    expect(await screen.findByText("Matrix")).toBeTruthy();
  });
});


/**
 * La moitié d'un titre doit suffire.
 *
 * Signalé à l'usage, capture à l'appui : « Hann » ne rendait que les deux obscurités qui
 * s'appellent littéralement ainsi, pendant qu'Hannibal dormait dans la bibliothèque. TMDB veut un
 * titre à peu près entier ; le catalogue, lui, est en mémoire et se cherche au préfixe.
 */
describe("PlayerSearchPanel — deviner la fin du mot", () => {
  it("trouve un titre de la bibliothèque sur son début, là où le serveur ne le voit pas", async () => {
    payload = { library: [], tmdb: [SHORT_FILM_HANN], persons: [] };
    await type("hann");

    expect(await screen.findByText("Hannibal")).toBeTruthy();
    // Et il passe devant : on peut le lancer tout de suite.
    const titles = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    const owned = titles.findIndex((text) => text.includes("Hannibal"));
    const other = titles.findIndex((text) => text.includes("Hann,"));
    expect(owned).toBeGreaterThanOrEqual(0);
    expect(other === -1 || owned < other).toBe(true);
  });

  it("ouvre la fiche de la bibliothèque, pas une fiche à demander", async () => {
    payload = { library: [], tmdb: [], persons: [] };
    await type("hanni");

    fireEvent.click(await screen.findByText("Hannibal"));
    expect(mockNavigate).toHaveBeenCalledWith({ tab: "movies", film: 7, serie: null });
  });

  // Les deux moteurs voient le même titre dès que la requête est entière : le serveur ignore ce
  // que la bibliothèque vient de trouver, et sans dédoublonnage la carte apparaissait deux fois.
  it("ne montre pas deux fois le titre que les deux moteurs ont trouvé", async () => {
    payload = {
      library: [{ ...OWNED, tmdbId: 1000, title: "Hannibal", year: 2001, radarrId: 7 }],
      tmdb: [], persons: [],
    };
    await type("hannibal");

    await waitFor(() => expect(screen.getAllByText("Hannibal")).toHaveLength(1));
  });
});

/**
 * Au clavier, entrer dans les résultats.
 *
 * Les flèches parcourent déjà la grille, mais elles se taisent tant qu'on écrit — la bonne règle,
 * sans quoi elles voleraient le curseur du champ. Restait le pas manquant, et il est au seul
 * endroit qui compte : passer du champ à la première affiche.
 */
describe("PlayerSearchPanel — du champ aux résultats", () => {
  it("descend sur la première carte à la flèche du bas", async () => {
    payload = { library: [OWNED], tmdb: [], persons: [] };
    await type("matrix");
    await screen.findByText("Matrix");

    const box = screen.getByRole("searchbox");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).textContent).toContain("Matrix");
  });

  // La loupe du clavier : elle valide, retient, et le focus quitte le champ — ce qui range le
  // clavier, lui qui recouvrait la moitié des résultats qu'on venait de demander.
  it("fait la même chose à la loupe du clavier, et retient la recherche", async () => {
    window.localStorage.clear();
    payload = { library: [OWNED], tmdb: [], persons: [] };
    await type("matrix");
    await screen.findByText("Matrix");

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(document.activeElement).not.toBe(screen.getByRole("searchbox"));
    expect(window.localStorage.getItem("cine.player.recentSearches")).toContain("matrix");
  });

  // Rien à viser : la touche range quand même le clavier plutôt que de ne rien faire.
  it("range le clavier quand il n'y a rien à viser", async () => {
    payload = { library: [], tmdb: [], persons: [] };
    await type("zzzzqqq");

    const box = screen.getByRole("searchbox");
    box.focus();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(document.activeElement).not.toBe(box);
  });
});

/**
 * Une recherche qui échoue le dit — et ne montre pas celle d'avant.
 *
 * `keepPreviousData` garde les résultats de la frappe précédente pendant que la suivante part, et
 * SWR les garde aussi quand elle échoue : hors ligne, on lisait sous « dune » les résultats de
 * « matrix », sans rien pour dire que la recherche n'avait pas abouti.
 */
describe("PlayerSearchPanel — une recherche qui échoue", () => {
  it("efface les résultats de la frappe d'avant et dit l'échec", async () => {
    payload = { library: [OWNED], tmdb: [], persons: [] };
    await type("matrix");
    await screen.findByText("Matrix");

    failing = true;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "dune" } });
    expect(await screen.findByText("player.search.failed")).toBeTruthy();
    expect(screen.queryByText("Matrix")).toBeNull();
  });

  it("ne dit pas « rien trouvé » quand on n'en sait rien", async () => {
    failing = true;
    await type("dune");
    expect(await screen.findByText("player.search.failed")).toBeTruthy();
    expect(screen.queryByText("player.search.noResults")).toBeNull();
  });
});
