// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

let payload: Record<string, unknown> = { library: [], tmdb: [], persons: [] };
vi.mock("@/lib/swr", () => ({ fetcher: async () => payload }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/components/PosterImage", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  PosterImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
const mockSetStatus = vi.fn();
vi.mock("@/lib/usePlayerTitleActions", () => ({
  usePlayerTitleActions: (ref: unknown) => ({
    busy: false,
    setStatus: (status: string) => mockSetStatus(status, ref),
    request: vi.fn(),
    cancelRequest: vi.fn(),
  }),
}));

import { PlayerListAdd } from "@/components/player/PlayerListAdd";

const MATRIX = {
  tmdbId: 603, title: "Matrix", year: 1999, posterPath: "/m.jpg", type: "movie",
  overview: "", rating: 8, radarrId: 42, sonarrId: null, inLibrary: true, sources: ["radarr"],
};
const DUNE = {
  tmdbId: 693134, title: "Dune", year: 2024, posterPath: null, type: "movie",
  overview: "", rating: 8, radarrId: null, sonarrId: null, inLibrary: false, sources: ["tmdb"],
};

function renderAdd(existing: string[] = []) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlayerListAdd existing={new Set(existing)} onClose={vi.fn()} />
    </SWRConfig>
  );
}

async function type(term: string) {
  fireEvent.change(screen.getByPlaceholderText("player.lists.addPlaceholder"), { target: { value: term } });
  await waitFor(() => expect(screen.queryByText("player.lists.addHint")).toBeNull(), { timeout: 2000 });
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("PlayerListAdd", () => {
  it("waits for something to search on rather than listing the world", () => {
    renderAdd();
    expect(screen.getByText("player.lists.addHint")).toBeTruthy();
  });

  // Le geste entier : on tape, on appuie sur le « + » de la ligne, c'est rangé. Sans ouvrir de
  // fiche, sans changer d'écran.
  it("adds a title to À voir straight from the result", async () => {
    payload = { library: [MATRIX], tmdb: [], persons: [] };
    renderAdd();
    await type("matrix");

    expect(await screen.findByText("Matrix")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("player.lists.addToWatch"));

    expect(mockSetStatus).toHaveBeenCalledWith("to_watch", expect.objectContaining({ tmdbId: 603, type: "movie" }));
    // Et la ligne le dit tout de suite, sans attendre le serveur.
    expect(await screen.findByLabelText("player.lists.alreadyInList")).toBeTruthy();
  });

  // Ce qu'on possède d'abord, le reste du monde ensuite — c'est ce qu'on ajoute le plus souvent.
  it("puts the library ahead of the rest of the world", async () => {
    payload = { library: [MATRIX], tmdb: [DUNE], persons: [] };
    renderAdd();
    await type("ma");

    const titles = screen.getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent);
    expect(titles).toEqual(["Matrix", "Dune"]);
  });

  // Un titre déjà rangé ne s'offre pas : la coche le dit, et le bouton ne répond plus.
  it("shows what is already listed as done, and refuses to add it twice", async () => {
    payload = { library: [MATRIX], tmdb: [], persons: [] };
    renderAdd(["movie-603"]);
    await type("matrix");

    const button = await screen.findByLabelText("player.lists.alreadyInList");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it("says so plainly when a search finds nothing", async () => {
    payload = { library: [], tmdb: [], persons: [] };
    renderAdd();
    await type("zzzz");
    expect(await screen.findByText("player.lists.addNothing")).toBeTruthy();
  });
});
