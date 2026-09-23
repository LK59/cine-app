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

/**
 * D'un onglet à l'autre, l'accueil ne passe plus (23/09/2026).
 *
 * Les deux panneaux se croisaient en fondu au même niveau : à mi-chemin, chacun à moitié
 * transparent, l'accueil se voyait à travers les deux. Remplacé, celui qui part reste plein et
 * passe dessous ; celui qui arrive fond par-dessus lui.
 */
describe("PlayerPanelFrame — d'un onglet à l'autre", () => {
  const root = (leaving: boolean, replaced: boolean) => {
    const { container } = render(
      <PlayerPanelFrame title="Titre" leaving={leaving} replaced={replaced}>
        <p>contenu</p>
      </PlayerPanelFrame>
    );
    return container.ownerDocument.querySelector<HTMLElement>(".fixed.inset-0.bg-ink")!;
  };

  it("remplacé, il reste plein et passe dessous", () => {
    const el = root(true, true);
    expect(el.className).not.toContain("animate-fade-out");
    expect(el.style.zIndex).toBe("45");
  });

  it("celui qui arrive est au-dessus", () => {
    const el = root(false, false);
    expect(el.className).toContain("animate-fade-in-side");
    expect(el.style.zIndex).toBe("46");
  });

  it("revenir à l'accueil garde sa sortie", () => {
    const el = root(true, false);
    expect(el.className).toContain("animate-fade-out-scale");
  });
});

/**
 * D'un onglet à l'autre, un changement instantané (23/09/2026) : même remplacé proprement, le
 * fondu croisé superposait deux pages, leurs titres presque au même endroit — l'écran semblait
 * clignoter, puis sauter.
 */
describe("PlayerPanelFrame — arrivée depuis un autre onglet", () => {
  const frame = (props: { leaving?: boolean; fromTab?: boolean }) => (
    <PlayerPanelFrame title="Titre" {...props}>
      <p>contenu</p>
    </PlayerPanelFrame>
  );
  const root = () => document.querySelector<HTMLElement>(".fixed.inset-0.bg-ink")!;

  it("apparaît d'un coup quand il arrive d'un autre onglet", () => {
    render(frame({ fromTab: true }));
    expect(root().className).not.toContain("animate-fade-in-side");
  });

  it("n'ajoute pas l'animation en retard quand l'onglet d'avant a fini de partir", () => {
    const { rerender } = render(frame({ fromTab: true }));
    rerender(frame({ fromTab: false }));
    expect(root().className).not.toContain("animate-fade-in-side");
  });

  it("entre en fondu quand il arrive de l'accueil", () => {
    render(frame({ fromTab: false }));
    expect(root().className).toContain("animate-fade-in-side");
  });

  it("décide à chaque nouvelle entrée", () => {
    const { rerender } = render(frame({ fromTab: true }));
    rerender(frame({ leaving: true }));
    rerender(frame({ leaving: false, fromTab: false }));
    expect(root().className).toContain("animate-fade-in-side");
  });
});
