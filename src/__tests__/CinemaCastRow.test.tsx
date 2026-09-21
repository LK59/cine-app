// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// La distribution en visages, revenue le 21/09/2026 dans les trois fiches du cinéma.

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
const cinemaNavigate = vi.fn();
vi.mock("@/lib/cinemaRoute", () => ({ cinemaNavigate: (...a: unknown[]) => cinemaNavigate(...a) }));

import { CinemaCastRow } from "@/components/cinema/CinemaCastRow";

afterEach(() => {
  cleanup();
  cinemaNavigate.mockClear();
});

const cast = [
  { tmdbId: 1, name: "Nathalie Baye", character: "Bertrande", photoUrl: "https://image.tmdb.org/t/p/w185/a.jpg" },
  { tmdbId: 2, name: "Gérard Depardieu", character: "", photoUrl: null },
];

describe("CinemaCastRow", () => {
  it("montre chaque visage avec son nom et son rôle", () => {
    render(<CinemaCastRow cast={cast} />);
    expect(screen.getByText("cinema.castTitle")).toBeTruthy();
    expect(screen.getByText("Nathalie Baye")).toBeTruthy();
    expect(screen.getByText("Bertrande")).toBeTruthy();
    // Sans photo, une silhouette plutôt qu'une image cassée.
    expect(document.querySelectorAll("img")).toHaveLength(1);
  });

  it("ouvre la fiche de la personne, sans quitter le cinéma", () => {
    render(<CinemaCastRow cast={cast} />);
    fireEvent.click(screen.getByText("Nathalie Baye"));
    expect(cinemaNavigate).toHaveBeenCalledWith({ person: 1 });
  });

  it("entre dans la navigation au clavier des rangées voisines", () => {
    render(<CinemaCastRow cast={cast} />);
    expect(document.querySelectorAll("[data-detail-similar]")).toHaveLength(2);
  });

  it("ne dessine rien sans distribution", () => {
    const { container } = render(<CinemaCastRow cast={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
