// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { useLongPress } from "@/lib/useLongPress";

/**
 * L'appui long d'un doigt ouvre le menu d'une carte ; le clic droit et la touche menu, au bureau,
 * aussi. Un doigt qui glisse fait défiler, et le clic qui suit un appui long n'ouvre pas le film
 * (23/09/2026).
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Card({ onMenu, onOpen }: { onMenu: () => void; onOpen: () => void }) {
  const press = useLongPress(onMenu);
  return (
    <button type="button" {...press} onClick={onOpen}>
      carte
    </button>
  );
}
const pointer = (el: Element, type: string, x = 0, y = 0, pointerType = "touch") =>
  act(() => void el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), { pointerType })));

describe("useLongPress", () => {
  it("ouvre le menu après une demi-seconde immobile, et avale le clic qui suit", () => {
    const onMenu = vi.fn();
    const onOpen = vi.fn();
    const { getByText } = render(<Card onMenu={onMenu} onOpen={onOpen} />);
    const card = getByText("carte");
    pointer(card, "pointerdown", 10, 10);
    act(() => void vi.advanceTimersByTime(499));
    expect(onMenu).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2));
    expect(onMenu).toHaveBeenCalledTimes(1);
    pointer(card, "pointerup", 10, 10);
    fireEvent.click(card);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("un appui bref ouvre le film, pas le menu", () => {
    const onMenu = vi.fn();
    const onOpen = vi.fn();
    const { getByText } = render(<Card onMenu={onMenu} onOpen={onOpen} />);
    const card = getByText("carte");
    pointer(card, "pointerdown");
    act(() => void vi.advanceTimersByTime(150));
    pointer(card, "pointerup");
    fireEvent.click(card);
    act(() => void vi.advanceTimersByTime(1000));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("un doigt qui glisse fait défiler, sans menu", () => {
    const onMenu = vi.fn();
    const { getByText } = render(<Card onMenu={onMenu} onOpen={vi.fn()} />);
    const card = getByText("carte");
    pointer(card, "pointerdown", 0, 0);
    pointer(card, "pointermove", 30, 0);
    act(() => void vi.advanceTimersByTime(1000));
    expect(onMenu).not.toHaveBeenCalled();
  });

  it("le clic droit et la touche menu l'ouvrent au bureau, sans le menu du navigateur", () => {
    const onMenu = vi.fn();
    const { getByText } = render(<Card onMenu={onMenu} onOpen={vi.fn()} />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => void getByText("carte").dispatchEvent(event));
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("la souris n'a pas d'appui long : elle a son clic droit", () => {
    const onMenu = vi.fn();
    const { getByText } = render(<Card onMenu={onMenu} onOpen={vi.fn()} />);
    pointer(getByText("carte"), "pointerdown", 0, 0, "mouse");
    act(() => void vi.advanceTimersByTime(1000));
    expect(onMenu).not.toHaveBeenCalled();
  });
});
