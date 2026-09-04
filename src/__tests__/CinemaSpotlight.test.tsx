// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CinemaSpotlight } from "@/components/cinema/CinemaSpotlight";

const railScroll = vi.fn();

beforeEach(() => {
  // jsdom n'implémente ni l'un ni l'autre : c'est ce que la rangée appelle qui nous intéresse.
  Element.prototype.scrollTo = railScroll;
  Element.prototype.scrollIntoView = vi.fn();
  railScroll.mockClear();
});
afterEach(() => cleanup());

function renderRail(activeIndex = 0, onPick = vi.fn()) {
  render(
    <CinemaSpotlight label="À la une" count={3} activeIndex={activeIndex} onPick={onPick}>
      <button type="button">Un</button>
      <button type="button">Deux</button>
      <button type="button">Trois</button>
    </CinemaSpotlight>
  );
  return onPick;
}

describe("la rangée à la une", () => {
  it("porte une barre par titre, et dit laquelle est en cours", () => {
    renderRail(1);
    const bars = screen.getAllByLabelText(/À la une \d\/3/);
    expect(bars).toHaveLength(3);
    expect(bars[1]).toHaveAttribute("aria-current", "true");
    expect(bars[0]).toHaveAttribute("aria-current", "false");
  });

  it("va droit au titre dont on clique la barre", async () => {
    const onPick = renderRail(0);
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("À la une 3/3"));
    expect(onPick).toHaveBeenCalledWith(2);
  });

  /**
   * La rotation continue toute seule : sans cela la bannière annoncerait au bout de quelques
   * tours un titre dont la carte est sortie de l'écran, et la section dirait le contraire de ce
   * qu'elle montre.
   */
  /**
   * Seul le rail bouge, et sur son seul axe : `scrollIntoView` aurait fait défiler tous les
   * ancêtres qui en ont besoin — dont le panneau vertical — et la rotation aurait déplacé la
   * page sous les pieds de qui parcourait les rangées plus bas.
   */
  it("amène la carte en cours sous les yeux, sans toucher au reste de la page", () => {
    renderRail(2);
    expect(railScroll).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    expect(railScroll.mock.calls[0][0]).not.toHaveProperty("top");
  });

  it("ne s'affiche pas quand il n'y a rien à mettre en avant", () => {
    const { container } = render(
      <CinemaSpotlight label="À la une" count={0} activeIndex={0} onPick={vi.fn()}>
        {null}
      </CinemaSpotlight>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("garde les cartes qu'on lui confie, dans l'ordre", () => {
    renderRail();
    expect(screen.getByText("Un")).toBeInTheDocument();
    expect(screen.getByText("Trois")).toBeInTheDocument();
  });

  /**
   * La bannière suit le survol, la rotation compte dans son coin : les deux se séparent, et une
   * barre allumée annonçait alors un titre que personne n'avait sous les yeux.
   */
  it("n'allume aucune barre quand la bannière montre un titre d'ailleurs", () => {
    renderRail(-1);
    for (const bar of screen.getAllByLabelText(/À la une \d\/3/)) {
      expect(bar).toHaveAttribute("aria-current", "false");
    }
  });

  it("ne fait rien défiler dans ce cas non plus", () => {
    renderRail(-1);
    expect(railScroll).not.toHaveBeenCalled();
  });
});
