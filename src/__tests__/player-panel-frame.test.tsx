// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false }));
vi.mock("@/lib/cinemaRoute", () => ({
  cinemaClose: vi.fn(),
  cinemaNavigate: vi.fn(),
  useCinemaRoute: () => ({ film: null, serie: null, discover: null, person: null }),
}));

import { PlayerPanelFrame } from "@/components/player/PlayerPanelFrame";

const panel = (leaving: boolean) => (
  <PlayerPanelFrame title="Titre" leaving={leaving}>
    <button data-nav-item>un</button>
    <button data-nav-item>deux</button>
  </PlayerPanelFrame>
);

afterEach(cleanup);

/**
 * Les flèches survivent à un retour rapide sur l'onglet.
 *
 * Le corps du panneau est re-clé à chaque retour sur un onglet qu'on venait de quitter — c'est ce
 * qui rejoue l'entrée. L'écouteur des flèches, lui, n'était posé qu'une fois, sur le premier corps :
 * après un aller-retour Recherche → Ma liste → Recherche plus rapide que la sortie, les flèches ne
 * faisaient plus rien dans le panneau.
 */
describe("PlayerPanelFrame — les flèches", () => {
  it("parcourent le panneau à son ouverture", () => {
    render(panel(false));
    fireEvent.keyDown(screen.getByText("un").parentElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("un"));
  });

  it("le parcourent encore après un retour en pleine sortie", () => {
    const { rerender } = render(panel(false));
    rerender(panel(true));
    // Rappelé avant la fin de sa sortie : le corps est un nœud neuf.
    rerender(panel(false));
    fireEvent.keyDown(screen.getByText("un").parentElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("un"));
  });
});
