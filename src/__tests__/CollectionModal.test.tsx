// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: vi.fn() }),
}));
const mockUseRole = vi.fn();
vi.mock("@/lib/useRole", () => ({ useRole: () => mockUseRole() }));

import { CollectionModal } from "@/components/CollectionModal";

const collection = {
  name: "La Saga",
  overview: "",
  parts: [
    { tmdbId: 11, title: "Premier volet", year: 1999, posterPath: null, voteAverage: 7.4, inLibrary: true, libraryHref: "/radarr/1" },
    { tmdbId: 22, title: "Second volet", year: 2003, posterPath: null, voteAverage: 6.8, inLibrary: false, libraryHref: null },
  ],
};

function stubApi(handler: (url: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const own = handler(url, init);
    if (own) return Promise.resolve(own);
    if (url.startsWith("/api/tmdb/collection/")) return Promise.resolve({ ok: true, json: async () => collection });
    if (url.startsWith("/api/watchlist/bulk-status")) return Promise.resolve({ ok: true, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderModal() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <CollectionModal collectionId={5} collectionName="La Saga" onClose={vi.fn()} />
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  mockUseRole.mockReturnValue({ role: "admin", isGuest: false });
  toastSuccess.mockClear();
  toastError.mockClear();
  // La carte ouvre sa feuille d'actions sur écran tactile ; on force le pointeur fin pour
  // atteindre les boutons de survol, qui sont ceux que l'on veut éprouver ici.
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
  }));
});

describe("fenêtre Saga", () => {
  /**
   * Le cas signalé en direct : depuis la fiche d'un film, « Saga » puis « recherche interactive »
   * sur un titre manquant ajoutait bien le film à Radarr, mais la fenêtre de recherche
   * n'apparaissait jamais — le parent reclassait aussitôt la carte parmi les titres présents,
   * ce qui la démontait avec l'état qui portait cette fenêtre.
   */
  it("ouvre la fenêtre de recherche après avoir ajouté un titre manquant", async () => {
    const fetchMock = stubApi((url) => {
      if (url === "/api/discover/add") return { ok: true, json: async () => ({ radarrId: 77 }) };
      if (url.startsWith("/api/radarr/movies/77/releases")) return { ok: true, json: async () => [] };
      return null;
    });
    const user = userEvent.setup();
    renderModal();

    await screen.findByText("Second volet");
    await user.click(screen.getByTitle("recommendations.interactiveSearch"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/discover/add", expect.objectContaining({ method: "POST" }))
    );
    // La fenêtre de recherche est bien montée : elle interroge les indexeurs du film ajouté.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/radarr/movies/77/releases")
    );
    expect(await screen.findByText("modals.releases.noResults")).toBeInTheDocument();
  });

  it("dit ce qui a bloqué quand Radarr refuse l'ajout", async () => {
    stubApi((url) =>
      url === "/api/discover/add"
        ? { ok: false, status: 400, statusText: "Bad Request", json: async () => ({ error: "Déjà dans Radarr" }) }
        : null
    );
    const user = userEvent.setup();
    renderModal();

    await screen.findByText("Second volet");
    await user.click(screen.getByTitle("recommendations.interactiveSearch"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Déjà dans Radarr"));
  });

  it("ne compte comme ajoutés que les titres que la watchlist a réellement acceptés", async () => {
    stubApi((url, init) =>
      url === "/api/watchlist" && init?.method === "POST"
        ? { ok: false, status: 500, statusText: "Server Error", json: async () => ({ error: "Base indisponible" }) }
        : null
    );
    const user = userEvent.setup();
    renderModal();

    await screen.findByText("Second volet");
    await user.click(screen.getByText("collection.addAllToWatchlist"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("watchlist.addFailed"));
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
