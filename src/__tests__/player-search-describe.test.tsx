// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

/**
 * La rangée « D'après votre description » de la recherche du cinéma (07/11/2026) : une requête à
 * part pour une frappe qui décrit, des squelettes à la place des cartes pendant l'attente, puis des
 * cartes ordinaires — et rien de répété de ce que la grille montre déjà en tête.
 */

const state = vi.hoisted(() => ({
  available: true,
  titles: { library: [], tmdb: [], persons: [] } as Record<string, unknown>,
  /** La réponse de `/api/search/describe?q=`. Une promesse : une réponse qui tarde. */
  described: null as unknown,
}));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (url: string) =>
    url === "/api/search/describe" ? { available: state.available, results: [] } : url === "/api/repliques" ? { available: false } : url.startsWith("/api/search") ? state.titles : {},
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));
const MATRIX = {
  radarrId: 7, jellyfinItemId: "a".repeat(32), tmdbId: 603, title: "Matrix", year: 1999, posterUrl: null,
  genres: ["Action"], imdbRating: "8.7", addedAt: null,
};
const catalogue = { items: [MATRIX], rows: { Action: [MATRIX] }, spotlight: [], recentlyAdded: [], top10: [] };
const homeCache = () =>
  new Map<string, { data: unknown }>([
    ["/api/cinema/movies", { data: catalogue }],
    ["/api/cinema/series", { data: { items: [], rows: {}, spotlight: [], recentlyAdded: [], top10: [] } }],
  ]);
vi.mock("@/lib/cinemaPayload", async (importOriginal) => ({
  catalogueTitles: (await importOriginal<typeof import("@/lib/cinemaPayload")>()).catalogueTitles,
  cinemaFetcher: async () => catalogue,
}));
vi.mock("@/components/PosterImage", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  PosterImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: vi.fn(), cinemaClose: vi.fn(), openLibraryTitle: vi.fn() }));
vi.mock("@/components/player/PlayerPanelFrame", () => ({ PlayerPanelFrame: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { PlayerSearchPanel, forgetSearchQuery } from "@/components/player/PlayerSearchPanel";

const fetches: { url: string; signal: AbortSignal }[] = [];
const result = (tmdbId: number, title: string, year: number, radarrId: number | null) => ({
  tmdbId, title, year, posterPath: null, type: "movie", overview: "", rating: 8,
  radarrId, sonarrId: null, inLibrary: radarrId !== null, available: radarrId !== null, sources: radarrId !== null ? ["radarr"] : ["tmdb"],
});

beforeEach(() => {
  vi.clearAllMocks();
  forgetSearchQuery();
  fetches.length = 0;
  state.available = true;
  state.titles = { library: [result(603, "Matrix", 1999, 7)], tmdb: [], persons: [] };
  state.described = { available: true, results: [result(137, "Un jour sans fin", 1993, null), result(603, "Matrix", 1999, 7)] };
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    fetches.push({ url, signal: init!.signal! });
    const body = state.described;
    if (body instanceof Promise) return body.then((b) => new Response(JSON.stringify(b), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }));
  render(
    <SWRConfig value={{ provider: homeCache, dedupingInterval: 0 }}>
      <PlayerSearchPanel />
    </SWRConfig>,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (term: string) => fireEvent.change(screen.getByRole("searchbox"), { target: { value: term } });
const DESCRIPTION = "le film avec un type qui revit la même journée";

describe("la rangée « D'après votre description »", () => {
  it("attend avec des squelettes, puis montre des cartes — sans répéter la grille", async () => {
    let answer!: (body: unknown) => void;
    state.described = new Promise((resolve) => (answer = resolve));
    type(DESCRIPTION);
    await waitFor(() => expect(fetches.map((f) => f.url)).toEqual([`/api/search/describe?q=${encodeURIComponent(DESCRIPTION)}`]));
    expect(screen.getByText("player.search.describe.title")).toBeTruthy();
    expect(document.querySelector("section[aria-busy='true'] .skeleton")).toBeTruthy();
    // Pas de « Rien trouvé » pendant qu'on attend la description.
    expect(screen.queryByText(/player.search.noResults/)).toBeNull();
    await act(async () => answer({ available: true, results: [result(137, "Un jour sans fin", 1993, null), result(603, "Matrix", 1999, 7)] }));
    const row = await screen.findByRole("button", { name: /Un jour sans fin/ });
    expect(row.closest("section")?.getAttribute("aria-busy")).toBe("false");
    // Pas dans la bibliothèque : la pastille le dit.
    expect(row.textContent).toContain("player.notInLibrary");
    // Matrix est déjà en tête de la grille : une seule carte, pas deux.
    expect(screen.getAllByRole("button", { name: /Matrix/ })).toHaveLength(1);
    // La puce « Tout » les compte (« Tout 0 » au-dessus d'Interstellar, 07/11/2026).
    expect(screen.getByRole("button", { name: /player.search.filterAll/ }).textContent).toBe("player.search.filterAll2");
  });

  it("un titre tapé n'appelle pas le modèle", async () => {
    type("matrix");
    await new Promise((r) => setTimeout(r, 800));
    expect(fetches).toEqual([]);
    expect(screen.queryByText("player.search.describe.title")).toBeNull();
  });

  it("abandonne la demande quand la frappe change", async () => {
    type(DESCRIPTION);
    await waitFor(() => expect(fetches).toHaveLength(1));
    type(`${DESCRIPTION} en boucle`);
    await waitFor(() => expect(fetches).toHaveLength(2));
    expect(fetches[0].signal.aborted).toBe(true);
  });

  it("rien de neuf trouvé : la rangée s'en va", async () => {
    state.described = { available: true, results: [result(603, "Matrix", 1999, 7)] };
    type(DESCRIPTION);
    await waitFor(() => expect(fetches).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("player.search.describe.title")).toBeNull());
  });

  it("coupée : ni rangée, ni requête", async () => {
    cleanup();
    state.available = false;
    render(
      <SWRConfig value={{ provider: homeCache, dedupingInterval: 0 }}>
        <PlayerSearchPanel />
      </SWRConfig>,
    );
    type(DESCRIPTION);
    await new Promise((r) => setTimeout(r, 800));
    expect(fetches).toEqual([]);
    expect(screen.queryByText("player.search.describe.title")).toBeNull();
  });
});
