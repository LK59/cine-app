// @vitest-environment jsdom
/**
 * La recherche globale de la gestion ne répond qu'à ce qu'on tape (DECISIONS §7 cinquies).
 *
 * Elle posait son propre `useSWR` sans option, sous le `keepPreviousData: true` que `SWRProvider`
 * donne à toute l'application : le champ vidé gardait les résultats de « dune », et hors ligne
 * ceux de « matrix » s'affichaient sous la saisie « dune » sans rien qui dise l'échec. Le
 * fournisseur est rejoué ici avec les options de production, pas celles, neutres, du test voisin.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));
vi.mock("@/lib/useRole", () => ({ useRole: () => ({ role: "admin" }) }));

import { GlobalSearch } from "@/components/GlobalSearch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// `offline` : les requêtes de recherche qui échouent, comme un téléphone qui perd le réseau.
function stubFetch(offline: Set<string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url === "/api/radarr/movies" || url === "/api/sonarr/series") return Promise.resolve({ ok: true, json: async () => [] });
      if (url.startsWith("/api/watchlist/bulk-status")) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.startsWith("/api/search")) {
        const q = new URL(url, "http://x").searchParams.get("q")!;
        if (offline.has(q)) return Promise.reject(new TypeError("Load failed"));
        return Promise.resolve({
          ok: true,
          json: async () => ({ library: [], persons: [], tmdb: [{ tmdbId: q.length, title: `Titre ${q}`, type: "movie", year: 2024, rating: 7, posterPath: null }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }),
  );
}

function renderSearch() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, dedupingInterval: 0, keepPreviousData: true, shouldRetryOnError: false }}>
      <GlobalSearch />
    </SWRConfig>,
  );
}

describe("GlobalSearch — les résultats d'une autre frappe ne restent pas", () => {
  it("champ vidé : les résultats de la recherche d'avant disparaissent", async () => {
    stubFetch(new Set());
    const user = userEvent.setup();
    renderSearch();
    fireEvent(window, new CustomEvent("open-search"));
    const input = await screen.findByPlaceholderText("search.placeholder");

    await user.type(input, "dune");
    expect(await screen.findByText("Titre dune")).toBeInTheDocument();

    await user.clear(input);
    await waitFor(() => expect(screen.queryByText("Titre dune")).not.toBeInTheDocument());
  });

  it("hors ligne : la frappe suivante efface ceux de la précédente et dit l'échec", async () => {
    stubFetch(new Set(["dune"]));
    const user = userEvent.setup();
    renderSearch();
    fireEvent(window, new CustomEvent("open-search"));
    const input = await screen.findByPlaceholderText("search.placeholder");

    await user.type(input, "matrix");
    expect(await screen.findByText("Titre matrix")).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "dune");
    expect(await screen.findByText("player.search.failed")).toBeInTheDocument();
    expect(screen.queryByText("Titre matrix")).not.toBeInTheDocument();
    // Un échec n'est pas « rien trouvé » : on n'en sait rien.
    expect(screen.queryByText(/search\.noResults/)).not.toBeInTheDocument();
  });
});
