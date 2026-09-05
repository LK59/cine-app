// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

// Le composant passe explicitement son propre fetcher à useSWR : celui de SWRConfig ne serait
// jamais appelé. C'est donc lui qu'on remplace.
let payload: Record<string, unknown> = {};
vi.mock("@/lib/swr", () => ({ fetcher: async () => payload }));

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
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
vi.mock("@/lib/usePlayerTitleActions", () => ({
  usePlayerTitleActions: () => ({ busy: false, cancelRequest: vi.fn(), setStatus: vi.fn(), request: vi.fn() }),
}));

// PlayerPanelFrame porte dans document.body et écoute Échap ; ici seul son contenu nous intéresse.
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { PlayerListPanel } from "@/components/player/PlayerListPanel";

const EMPTY_LISTS = { requests: [], toWatch: [], watched: [], abandoned: [], favorites: [] };

function renderWith(lists: Record<string, unknown>) {
  payload = lists;
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlayerListPanel />
    </SWRConfig>
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("PlayerListPanel", () => {
  it("opens on the first segment that has something rather than on an empty Demandes", async () => {
    renderWith({
      ...EMPTY_LISTS,
      toWatch: [{ tmdbId: 603, type: "movie", title: "Matrix", year: 1999, poster: null, libraryId: 42, jellyfinId: null }],
    });

    // L'onglet « À voir » est celui qui porte son contenu : la carte est là, pas le vide de
    // « Demandes ».
    expect(await screen.findByText("Matrix")).toBeTruthy();
    expect(screen.queryByText("player.lists.empty.requests")).toBeNull();
  });

  it("keeps an explicit choice even when that segment is empty", async () => {
    renderWith({
      ...EMPTY_LISTS,
      toWatch: [{ tmdbId: 603, type: "movie", title: "Matrix", year: 1999, poster: null, libraryId: 42, jellyfinId: null }],
    });

    await screen.findByText("Matrix");
    fireEvent.click(screen.getByText(/player\.lists\.abandoned/));
    expect(screen.getByText("player.lists.empty.abandoned")).toBeTruthy();
  });

  // La pastille ne compte que ce qui est arrivé : c'est la seule chose de cet écran qui mérite
  // qu'on attire l'œil dessus.
  it("counts only the arrived requests in the badge", async () => {
    renderWith({
      ...EMPTY_LISTS,
      requests: [
        { id: 1, tmdbId: 1, type: "movie", title: "Arrivé", poster: null, year: 2020, state: "available", requestedAt: "", canCancel: true, libraryId: 7 },
        { id: 2, tmdbId: 2, type: "movie", title: "En route", poster: null, year: 2021, state: "processing", requestedAt: "", canCancel: true, libraryId: null },
      ],
    });

    expect(await screen.findByLabelText("player.lists.arrivedBadge")).toBeTruthy();
    expect(screen.getByText("player.requests.state.available")).toBeTruthy();
    expect(screen.getByText("player.requests.state.processing")).toBeTruthy();
  });

  it("sends an arrived request to its library sheet, not to the TMDB one", async () => {
    renderWith({
      ...EMPTY_LISTS,
      requests: [
        { id: 1, tmdbId: 603, type: "movie", title: "Arrivé", poster: null, year: 2020, state: "available", requestedAt: "", canCancel: true, libraryId: 7 },
      ],
    });

    fireEvent.click(await screen.findByText("player.requests.state.available"));
    // Ma liste reste ouverte sous la fiche (pas de `list: false`) pour qu'un retour y ramène, et
    // l'onglet suit le type.
    expect(mockNavigate).toHaveBeenCalledWith({ tab: "movies", film: 7, serie: null });
  });

  // Le bug signalé : une série cliquée depuis Ma liste renvoyait brutalement à l'accueil, parce
  // que l'onglet restait sur « Films » et que l'écran ne savait donc pas quoi ouvrir.
  it("carries the series tab when opening a series from the list", async () => {
    renderWith({
      ...EMPTY_LISTS,
      toWatch: [{ tmdbId: 1399, type: "series", title: "Game of Thrones", year: 2011, poster: null, libraryId: 50, jellyfinId: null }],
    });

    fireEvent.click(await screen.findByText("Game of Thrones"));
    expect(mockNavigate).toHaveBeenCalledWith({ tab: "series", serie: 50, film: null });
  });

  it("opens a title we do not have on its TMDB sheet", async () => {
    renderWith({
      ...EMPTY_LISTS,
      toWatch: [{ tmdbId: 693134, type: "movie", title: "Dune", year: 2024, poster: null, libraryId: null, jellyfinId: null }],
    });

    fireEvent.click(await screen.findByText("Dune"));
    expect(mockNavigate).toHaveBeenCalledWith({ discover: 693134, discoverType: "movie" });
  });
});
