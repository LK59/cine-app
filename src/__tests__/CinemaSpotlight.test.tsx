// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CinemaSpotlight } from "@/components/cinema/CinemaSpotlight";

const scrollIntoView = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
  scrollIntoView.mockClear();
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
  it("amène la carte en cours sous les yeux", () => {
    renderRail(2);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: "center" }));
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
});
