// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TapButton } from "@/components/TapButton";

afterEach(cleanup);

/**
 * 04/10/2026 : au bout d'une page qu'on vient de faire défiler, iOS gardait le premier clic pour
 * arrêter l'élan — « Voir tous les films » demandait deux appuis. L'appui est servi au relâchement.
 */
describe("un appui servi au relâchement", () => {
  const setup = () => {
    const onTap = vi.fn();
    render(<TapButton onTap={onTap}>Voir tout</TapButton>);
    return { onTap, button: screen.getByRole("button") };
  };

  it("part au relâchement du doigt, et le clic qui suit ne le rejoue pas", () => {
    const { onTap, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(button, { pointerType: "touch", pointerId: 1, clientX: 12, clientY: 11 });
    expect(onTap).toHaveBeenCalledTimes(1);
    fireEvent.click(button);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("ne part pas pour un doigt qui a glissé (un défilement), ni pour un geste repris", () => {
    const { onTap, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "touch", pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(button, { pointerType: "touch", pointerId: 2, clientX: 10, clientY: 60 });
    fireEvent.pointerDown(button, { pointerType: "touch", pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(button, { pointerId: 3 });
    fireEvent.pointerUp(button, { pointerType: "touch", pointerId: 3, clientX: 10, clientY: 10 });
    expect(onTap).not.toHaveBeenCalled();
  });

  it("garde le clic pour la souris et le clavier", () => {
    const { onTap, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "mouse", pointerId: 4 });
    fireEvent.pointerUp(button, { pointerType: "mouse", pointerId: 4 });
    expect(onTap).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});
