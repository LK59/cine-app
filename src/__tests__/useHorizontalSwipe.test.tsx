// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useHorizontalSwipe } from "@/lib/useHorizontalSwipe";

afterEach(() => cleanup());

function Harness({ onSwipe }: { onSwipe: (d: 1 | -1) => void }) {
  const swipe = useHorizontalSwipe(onSwipe);
  return <div data-testid="zone" {...swipe.handlers} style={swipe.style} />;
}

/** Un geste, en trois événements de pointeur. */
function drag(dx: number, dy = 0) {
  const zone = screen.getByTestId("zone");
  fireEvent.pointerDown(zone, { clientX: 100, clientY: 100, pointerType: "touch" });
  fireEvent.pointerMove(zone, { clientX: 100 + dx, clientY: 100 + dy, pointerType: "touch" });
  fireEvent.pointerUp(zone, { pointerType: "touch" });
}

describe("le balayage horizontal", () => {
  it("avance quand on tire vers la gauche", () => {
    const onSwipe = vi.fn();
    render(<Harness onSwipe={onSwipe} />);
    drag(-80);
    expect(onSwipe).toHaveBeenCalledWith(1);
  });

  it("recule quand on tire vers la droite", () => {
    const onSwipe = vi.fn();
    render(<Harness onSwipe={onSwipe} />);
    drag(80);
    expect(onSwipe).toHaveBeenCalledWith(-1);
  });

  it("ignore un frôlement trop court pour être une intention", () => {
    const onSwipe = vi.fn();
    render(<Harness onSwipe={onSwipe} />);
    drag(-20);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  /**
   * Le geste appartient à la page tant qu'il monte ou descend : le reprendre en cours de route
   * ferait sauter l'affiche pendant qu'on lit ce qu'il y a en dessous.
   */
  it("laisse le défilement vertical à la page", () => {
    const onSwipe = vi.fn();
    render(<Harness onSwipe={onSwipe} />);
    drag(-60, -200);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("ne se déclenche qu'une fois par geste", () => {
    const onSwipe = vi.fn();
    render(<Harness onSwipe={onSwipe} />);
    const zone = screen.getByTestId("zone");
    fireEvent.pointerDown(zone, { clientX: 200, clientY: 100, pointerType: "touch" });
    fireEvent.pointerMove(zone, { clientX: 120, clientY: 100, pointerType: "touch" });
    fireEvent.pointerMove(zone, { clientX: 40, clientY: 100, pointerType: "touch" });
    fireEvent.pointerUp(zone, { pointerType: "touch" });
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  /** Sans cela le navigateur garderait le geste entier pour son propre défilement. */
  it("ne réclame que l'axe horizontal", () => {
    render(<Harness onSwipe={vi.fn()} />);
    expect(screen.getByTestId("zone").style.touchAction).toBe("pan-y");
  });
});
