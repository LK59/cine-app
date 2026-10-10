// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CinemaTop10Card } from "@/components/cinema/CinemaTop10Card";

// Les cartes du Top 10 : servies au relâchement du doigt, comme les autres affiches (`useTap`).
// Au `click`, iOS gardait le premier appui juste après un défilement de la rangée — la fiche du
// Top 10 semblait lente à s'ouvrir (Louis, iPhone, 10/10/2026).

vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

afterEach(() => cleanup());

function card(onSelectItem = vi.fn()) {
  render(
    <CinemaTop10Card rank={3} title="Old Boy" posterUrl={null} addedAt={null} widthClassName="w-24" numberFontSize="6rem" onSelectItem={onSelectItem} />,
  );
  return { el: screen.getByRole("button", { name: "3. Old Boy" }), onSelectItem };
}

describe("une carte du Top 10", () => {
  it("s'ouvre au relâchement du doigt, sans attendre le `click`", () => {
    const { el, onSelectItem } = card();
    fireEvent.pointerDown(el, { pointerType: "touch", pointerId: 7, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(el, { pointerType: "touch", pointerId: 7, clientX: 21, clientY: 20 });
    expect(onSelectItem).toHaveBeenCalledTimes(1);
    // Le `click` qui suit ne rouvre pas une seconde fois.
    fireEvent.click(el);
    expect(onSelectItem).toHaveBeenCalledTimes(1);
  });

  it("un doigt qui a glissé (la rangée défilait) n'ouvre rien", () => {
    const { el, onSelectItem } = card();
    fireEvent.pointerDown(el, { pointerType: "touch", pointerId: 8, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(el, { pointerType: "touch", pointerId: 8, clientX: 60, clientY: 20 });
    expect(onSelectItem).not.toHaveBeenCalled();
  });

  it("à la souris et au clavier du bureau, le `click` suffit", () => {
    const { el, onSelectItem } = card();
    fireEvent.click(el);
    expect(onSelectItem).toHaveBeenCalledTimes(1);
  });
});
