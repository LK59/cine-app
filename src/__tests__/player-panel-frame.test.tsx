// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
let mobile = false;
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => mobile, useIsShortViewport: () => false }));
vi.mock("@/lib/cinemaRoute", () => ({
  CLOSE_PANELS: { search: false, list: false, account: false, browse: null, activity: null, report: null },
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

afterEach(() => {
  cleanup();
  mobile = false;
});

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
    return container.ownerDocument.querySelector<HTMLElement>("[data-panel-root]")!;
  };

  it("remplacé, il reste plein et passe dessous — sur téléphone", () => {
    mobile = true;
    const el = root(true, true);
    expect(el.className).not.toContain("animate-fade-out");
    expect(el.style.zIndex).toBe("45");
  });

  // Sur grand écran les fenêtres n'ont pas la même largeur : restée pleine, l'ancienne dépassait
  // autour de la nouvelle puis disparaissait d'un coup (26/09/2026).
  it("remplacé, il s'efface dessous — sur grand écran", () => {
    const el = root(true, true);
    expect(el.className).toContain("animate-fade-out-scale");
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
  const root = () => document.querySelector<HTMLElement>("[data-panel-root]")!;

  it("apparaît d'un coup quand il arrive d'un autre onglet — sur téléphone", () => {
    mobile = true;
    render(frame({ fromTab: true }));
    expect(root().className).not.toContain("animate-fade-in-side");
    expect(root().className).not.toContain("panel-swap-in");
  });

  it("entre après l'autre fenêtre quand il arrive d'un autre onglet — sur grand écran", () => {
    render(frame({ fromTab: true }));
    expect(root().className).toContain("panel-swap-in");
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

// Échap revenait au panneau quoi qu'il y ait au-dessus : sous l'accueil, il refermait le panneau
// Compte (l'accueil restait) ; dans la recherche d'ajout de « Ma liste », il quittait tout l'écran
// (23/09/2026).
describe("PlayerPanelFrame — Échap", () => {
  it("referme le panneau quand rien d'autre ne le réclame", async () => {
    const { cinemaClose } = await import("@/lib/cinemaRoute");
    render(panel(false));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cinemaClose).toHaveBeenCalledTimes(1);
  });

  it("se tait sous une fenêtre de dialogue", async () => {
    const { cinemaClose } = await import("@/lib/cinemaRoute");
    vi.mocked(cinemaClose).mockClear();
    render(panel(false));
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(cinemaClose).not.toHaveBeenCalled();
    dialog.remove();
  });

  it("laisse Échap à l'élément qui le gère lui-même", async () => {
    const { cinemaClose } = await import("@/lib/cinemaRoute");
    vi.mocked(cinemaClose).mockClear();
    render(
      <PlayerPanelFrame title="Titre">
        <input data-owns-escape aria-label="ajout" />
      </PlayerPanelFrame>
    );
    fireEvent.keyDown(screen.getByLabelText("ajout"), { key: "Escape" });
    expect(cinemaClose).not.toHaveBeenCalled();
  });
});

// Sur le bureau, la réserve de la barre du bas vaut zéro : « Se déconnecter » touchait le bord de
// la fenêtre (23/09/2026).
describe("PlayerPanelFrame — le bas", () => {
  it("garde toujours un peu d'air sous le dernier élément", () => {
    render(panel(false));
    const body = screen.getByText("un").parentElement!;
    expect(body.style.paddingBottom).toContain("max(var(--player-bar-space, 4rem), 2.5rem)");
  });
});

// Sur grand écran, un clic à côté de la fenêtre la ferme (26/09/2026) — mais pas une sélection de
// texte commencée dedans et relâchée dehors, que le navigateur livre comme un clic sur la racine.
describe("PlayerPanelFrame — clic à côté de la fenêtre", () => {
  const root = () => document.querySelector<HTMLElement>("[data-panel-root]")!;

  it("ferme le panneau", async () => {
    const { cinemaClose } = await import("@/lib/cinemaRoute");
    vi.mocked(cinemaClose).mockClear();
    render(panel(false));
    fireEvent.pointerDown(root());
    fireEvent.click(root());
    expect(cinemaClose).toHaveBeenCalledTimes(1);
  });

  it("ne ferme pas sur un clic dans la fenêtre", async () => {
    const { cinemaClose } = await import("@/lib/cinemaRoute");
    vi.mocked(cinemaClose).mockClear();
    render(panel(false));
    fireEvent.pointerDown(screen.getByText("un"));
    fireEvent.click(screen.getByText("un"));
    expect(cinemaClose).not.toHaveBeenCalled();
  });

  it("ne ferme pas sur un geste commencé dans la fenêtre et relâché dehors", async () => {
    const { cinemaClose } = await import("@/lib/cinemaRoute");
    vi.mocked(cinemaClose).mockClear();
    render(panel(false));
    fireEvent.pointerDown(screen.getByText("un"));
    fireEvent.click(root());
    expect(cinemaClose).not.toHaveBeenCalled();
  });
});

// Le Compte et l'activité ou les signalements qu'il ouvre : deux fenêtres de largeurs différentes
// se croisaient en même temps sur grand écran (26/09/2026). Le téléphone garde son entrée.
describe("PlayerPanelFrame — une fenêtre qui en remplace une autre sans être un onglet", () => {
  const root = () => document.querySelector<HTMLElement>("[data-panel-root]")!;
  const frame = (swapIn: boolean) => (
    <PlayerPanelFrame title="Titre" back swapIn={swapIn}>
      <p>contenu</p>
    </PlayerPanelFrame>
  );

  it("entre après l'autre sur grand écran", () => {
    render(frame(true));
    expect(root().className).toContain("panel-swap-in");
  });

  it("garde son entrée sur téléphone", () => {
    mobile = true;
    render(frame(true));
    expect(root().className).toContain("animate-fade-in-side");
  });

  it("entre normalement quand rien ne part", () => {
    render(frame(false));
    expect(root().className).toContain("animate-fade-in-side");
  });
});
