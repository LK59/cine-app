// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { LongPressButton } from "@/components/cinema/mobile/CinemaMobileClient";

// Les cartes de « Reprendre » au téléphone (DECISIONS.md §61) : servies au relâchement du doigt.
// Servies au `click`, elles attendaient celui qu'iOS retient juste après un défilement ou pendant le
// retour d'une fiche — « lent de réactivité », impossible de rouvrir une reprise coup sur coup
// (Louis, iPhone, 10/10/2026).

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function card(onClick = vi.fn(), onLongPress = vi.fn()) {
  render(
    <LongPressButton onClick={onClick} onLongPress={onLongPress} className="">
      reprise
    </LongPressButton>,
  );
  return { el: screen.getByText("reprise"), onClick, onLongPress };
}

describe("une carte de « Reprendre »", () => {
  it("s'ouvre au relâchement du doigt, sans attendre un `click` qu'iOS peut retenir", () => {
    const { el, onClick } = card();
    fireEvent.pointerDown(el, { pointerType: "touch", pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(el, { pointerType: "touch", pointerId: 3, clientX: 11, clientY: 10 });
    expect(onClick).toHaveBeenCalledTimes(1);
    // Le `click` qui suit, quand il vient, ne rouvre pas une seconde fois.
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("un appui long ouvre le menu, et pas la fiche en plus", () => {
    vi.useFakeTimers();
    const { el, onClick, onLongPress } = card();
    fireEvent.pointerDown(el, { pointerType: "touch", pointerId: 4, clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(550);
    });
    fireEvent.pointerUp(el, { pointerType: "touch", pointerId: 4, clientX: 10, clientY: 10 });
    fireEvent.click(el);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("au clavier et à la souris, le `click` suffit", () => {
    const { el, onClick } = card();
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
