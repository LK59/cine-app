// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

let payload: Record<string, unknown> = { library: [], tmdb: [], persons: [] };
vi.mock("@/lib/swr", () => ({ fetcher: async () => payload }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/components/PosterImage", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  PosterImage: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
const mockNavigate = vi.fn();
vi.mock("@/lib/cinemaRoute", () => ({
  cinemaNavigate: (...a: unknown[]) => mockNavigate(...a),
  cinemaClose: vi.fn(),
}));
vi.mock("@/components/player/PlayerPanelFrame", () => ({
  PlayerPanelFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { PlayerSearchPanel } from "@/components/player/PlayerSearchPanel";

const OWNED = {
  tmdbId: 603, title: "Matrix", year: 1999, posterPath: null, type: "movie",
  overview: "", rating: 8, radarrId: 42, sonarrId: null, inLibrary: true, sources: ["radarr"],
};
const MISSING = {
  tmdbId: 693134, title: "Dune", year: 2024, posterPath: null, type: "movie",
  overview: "", rating: 8, radarrId: null, sonarrId: null, inLibrary: false, sources: ["tmdb"],
};
const PERSON = { id: 6384, name: "Keanu Reeves", profilePath: null, department: "Acting", knownFor: [], libraryCount: 3, libraryTitles: [] };

async function type(term: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: term } });
  await waitFor(() => expect(screen.queryByText("player.search.hint")).toBeNull(), { timeout: 2000 });
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(mockNavigate).toHaveBeenCalledWith({ search: false, film: 42 });

    fireEvent.click(screen.getByText("Dune"));
    expect(mockNavigate).toHaveBeenCalledWith({ search: false, discover: 693134, discoverType: "movie" });
  });

  it("sends a person to their own sheet", async () => {
    payload = { library: [], tmdb: [], persons: [PERSON] };
    await type("keanu");

    fireEvent.click(await screen.findByText("Keanu Reeves"));
    expect(mockNavigate).toHaveBeenCalledWith({ search: false, person: 6384 });
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
