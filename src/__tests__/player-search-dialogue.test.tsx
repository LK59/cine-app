// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

/**
 * La section « Répliques » de la recherche du cinéma (DECISIONS.md §88) : les titres d'abord, à la
 * même vitesse ; les répliques après, par une requête à part, abandonnée quand la frappe change ;
 * la puce pour ne chercher que dans les dialogues ; un appui lance le film cinq secondes avant.
 */

const state = vi.hoisted(() => ({
  available: true,
  titles: { library: [], tmdb: [], persons: [] } as Record<string, unknown>,
  /** La réponse de `/api/repliques?q=` ; `null` : celle par défaut. Une promesse : une réponse qui tarde. */
  dialogue: null as unknown,
}));
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: async (url: string) => (url === "/api/repliques" ? { available: state.available } : url.startsWith("/api/search") ? state.titles : {}),
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
const play = vi.fn();
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ play }) }));

import { PlayerSearchPanel, forgetSearchQuery } from "@/components/player/PlayerSearchPanel";
import { dialogueResumeAt, highlightSegments, wantsDialogueSearch } from "@/lib/dialogueSearch";

const fetches: { url: string; signal: AbortSignal }[] = [];
const DIALOGUE = {
  available: true,
  terms: ["choisis", "pilule"],
  prefixes: ["pilul"],
  films: [
    { itemId: "a".repeat(32), radarrId: 7, more: 0, lines: [{ startMs: 42_500, endMs: 45_000, lang: "fr", text: "Tu choisis la pilule bleue." }] },
    // Absent du catalogue de l'appareil : jamais montré.
    { itemId: "f".repeat(32), radarrId: 99, more: 0, lines: [{ startMs: 1000, endMs: 2000, lang: "fr", text: "Caché." }] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  forgetSearchQuery();
  fetches.length = 0;
  state.available = true;
  state.dialogue = null;
  state.titles = { library: [{ tmdbId: 603, title: "Matrix", year: 1999, posterPath: null, type: "movie", overview: "", rating: 8, radarrId: 7, sonarrId: null, inLibrary: true, sources: ["radarr"] }], tmdb: [], persons: [] };
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    fetches.push({ url, signal: init!.signal! });
    if (state.dialogue instanceof Promise) return state.dialogue.then((body) => new Response(JSON.stringify(body), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify(state.dialogue ?? DIALOGUE), { status: 200 }));
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

describe("la section Répliques", () => {
  it("montre les titres d'abord, puis les répliques par une requête à part", async () => {
    type("tu choisis la pilule");
    // Les titres de la bibliothèque, à la lettre : la section des répliques n'a encore rien demandé.
    expect(await screen.findByText("Matrix")).toBeTruthy();
    expect(fetches).toEqual([]);
    await waitFor(() => expect(fetches.map((f) => f.url)).toEqual(["/api/repliques?q=tu%20choisis%20la%20pilule"]));
    await waitFor(() => expect(screen.getByText("0:00:42")).toBeTruthy());
    expect(document.querySelector("mark")?.closest("button")?.textContent).toContain("Tu choisis la pilule bleue.");
    expect(screen.queryByText("Caché.")).toBeNull();
    // Mots trouvés mis en évidence.
    expect([...document.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["choisis", "pilule"]);
  });

  it("ne cherche pas dans les dialogues sous trois mots, et abandonne la requête quand la frappe change", async () => {
    type("matrix");
    await new Promise((r) => setTimeout(r, 500));
    expect(fetches).toEqual([]);
    type("tu choisis la");
    await waitFor(() => expect(fetches).toHaveLength(1));
    type("tu choisis la pilule");
    await waitFor(() => expect(fetches).toHaveLength(2));
    expect(fetches[0].signal.aborted).toBe(true);
    expect(fetches[1].signal.aborted).toBe(false);
  });

  it("lance le film cinq secondes avant la réplique, en mode scène", async () => {
    type("tu choisis la pilule");
    const line = await screen.findByRole("button", { name: /player.search.dialogue.playAt/ }, { timeout: 2000 });
    act(() => fireEvent.click(line));
    // Une scène (§91) : lancée depuis une réplique, elle n'est pas une reprise.
    expect(play).toHaveBeenCalledWith({ itemId: "a".repeat(32), title: "Matrix", resumeAt: 37.5, scene: true });
  });

  it("la puce « Répliques » ne cherche que dans les dialogues, dès un mot", async () => {
    type("pilule");
    const chip = await screen.findByRole("button", { name: /player.search.dialogue.chip/ });
    act(() => fireEvent.click(chip));
    await waitFor(() => expect(fetches.map((f) => f.url)).toEqual(["/api/repliques?q=pilule"]));
    // Les titres s'effacent : on a dit qu'on cherchait une réplique.
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Matrix/ })).toBeNull());
  });
});

describe("ce que la section dit", () => {
  it("nomme la réplique dans le nom du bouton, pour un lecteur d'écran", async () => {
    type("tu choisis la pilule");
    const line = await screen.findByRole("button", { name: /player.search.dialogue.playAt/ }, { timeout: 2000 });
    expect(line.getAttribute("aria-label")).toContain("Tu choisis la pilule bleue.");
  });

  it("dit que les mots sont trop courants plutôt qu'« aucune réplique »", async () => {
    state.dialogue = { available: true, terms: [], prefixes: [], films: [], tooCommon: true };
    type("je je je");
    expect(await screen.findByText("player.search.dialogue.tooCommon", undefined, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByText("player.search.dialogue.none")).toBeNull();
  });

  it("annonce des répliques approchantes", async () => {
    state.dialogue = { ...DIALOGUE, approximate: true };
    type("tu choisis la pilule rouge");
    expect(await screen.findByText("player.search.dialogue.approximate", undefined, { timeout: 2000 })).toBeTruthy();
  });

  it("garde les répliques précédentes, estompées, pendant que la nouvelle réponse arrive", async () => {
    type("tu choisis la pilule");
    await screen.findByText("0:00:42", undefined, { timeout: 2000 });
    let answer!: (body: unknown) => void;
    state.dialogue = new Promise((resolve) => (answer = resolve));
    type("tu choisis la pilule bleue");
    await waitFor(() => expect(fetches).toHaveLength(2));
    // Pas de « Recherche… » à la place des résultats : ils restent, estompés.
    expect(screen.getByText("0:00:42")).toBeTruthy();
    expect(screen.queryByText("player.search.dialogue.loading")).toBeNull();
    expect(screen.getByText("0:00:42").closest("ul.opacity-50")).toBeTruthy();
    await act(async () => answer({ ...DIALOGUE, films: [] }));
    await waitFor(() => expect(screen.getByText("player.search.dialogue.none")).toBeTruthy());
  });
});

describe("sans recherche de répliques", () => {
  it("ni puce, ni requête, quand l'option est coupée ou l'index vide", async () => {
    cleanup();
    state.available = false;
    render(
      <SWRConfig value={{ provider: homeCache, dedupingInterval: 0 }}>
        <PlayerSearchPanel />
      </SWRConfig>,
    );
    type("tu choisis la pilule");
    expect(await screen.findByText("Matrix")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    expect(fetches).toEqual([]);
    expect(screen.queryByText("player.search.dialogue.chip")).toBeNull();
  });
});

describe("les règles", () => {
  it("cinq secondes avant, jamais avant le début", () => {
    expect(dialogueResumeAt(42_500)).toBe(37.5);
    expect(dialogueResumeAt(2_000)).toBe(0);
    expect(dialogueResumeAt(0)).toBe(0);
  });
  it("trois mots sous les titres, trois lettres avec la puce", () => {
    expect(wantsDialogueSearch("je suis", false)).toBe(false);
    expect(wantsDialogueSearch("je suis ton", false)).toBe(true);
    expect(wantsDialogueSearch("pi", true)).toBe(false);
    expect(wantsDialogueSearch("pil", true)).toBe(true);
  });
  it("met en évidence sans tenir compte des accents ni des majuscules", () => {
    expect(highlightSegments("Ton PÈRE est là.", ["pere"], [])).toEqual([
      { text: "Ton ", hit: false },
      { text: "PÈRE", hit: true },
      { text: " est là.", hit: false },
    ]);
  });
});
