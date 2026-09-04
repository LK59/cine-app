// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useCarouselDrag } from "@/lib/useCarouselDrag";

afterEach(() => cleanup());
beforeEach(() => {
  // jsdom ne met rien en page : la largeur de la piste sert à décider du seuil d'engagement.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { value: 400, configurable: true });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});

function Harness({ index, count, onIndexChange }: { index: number; count: number; onIndexChange: (n: number) => void }) {
  const drag = useCarouselDrag({ count, index, onIndexChange });
  return (
    <div data-testid="track" {...drag.handlers} style={drag.style} data-dx={drag.dx} data-dragging={drag.dragging} />
  );
}

const track = () => screen.getByTestId("track");
const dx = () => Number(track().getAttribute("data-dx"));
const dragging = () => track().getAttribute("data-dragging") === "true";

function down(x = 200, y = 200) {
  fireEvent.pointerDown(track(), { clientX: x, clientY: y, pointerType: "touch", pointerId: 1 });
}
function move(x: number, y = 200) {
  fireEvent.pointerMove(track(), { clientX: x, clientY: y, pointerType: "touch", pointerId: 1 });
}
function up(x: number, y = 200) {
  fireEvent.pointerUp(track(), { clientX: x, clientY: y, pointerType: "touch", pointerId: 1 });
}

describe("la traînée du carrousel", () => {
  it("suit le doigt pendant le geste", () => {
    render(<Harness index={1} count={5} onIndexChange={vi.fn()} />);
    down();
    move(140);
    expect(dragging()).toBe(true);
    expect(dx()).toBe(-60);
  });

  it("passe au titre suivant quand on est allé assez loin", () => {
    const onIndexChange = vi.fn();
    render(<Harness index={1} count={5} onIndexChange={onIndexChange} />);
    down();
    move(60); // 140 px sur 400, au-delà du quart
    up(60);
    expect(onIndexChange).toHaveBeenCalledWith(2);
    expect(dx()).toBe(0);
  });

  it("revient à sa place quand le geste s'arrête trop tôt", () => {
    const onIndexChange = vi.fn();
    render(<Harness index={1} count={5} onIndexChange={onIndexChange} />);
    down();
    // Vingt pixels : ni la distance (un quart de 400, soit 100) ni le plancher du lancer (24)
    // ne sont atteints.
    move(180);
    up(180);
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(dx()).toBe(0);
  });

  it("recule quand on tire vers la droite", () => {
    const onIndexChange = vi.fn();
    render(<Harness index={2} count={5} onIndexChange={onIndexChange} />);
    down();
    move(340);
    up(340);
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  /**
   * Les deux défauts d'un carrousel dans une page qui défile : une affiche qui part de travers
   * pendant qu'on lit plus bas, et une page qui refuse de défiler parce que le carrousel a
   * confisqué le geste. L'axe se décide une fois, et ne change plus.
   */
  it("laisse le geste vertical à la page, et ne le reprend pas en route", () => {
    const onIndexChange = vi.fn();
    render(<Harness index={1} count={5} onIndexChange={onIndexChange} />);
    down();
    move(196, 60); // surtout vertical : l'axe est concédé
    move(20, 60); // franchement horizontal, mais trop tard
    up(20, 60);
    expect(dragging()).toBe(false);
    expect(dx()).toBe(0);
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("ne réclame que l'axe horizontal au navigateur", () => {
    render(<Harness index={0} count={3} onIndexChange={vi.fn()} />);
    expect(track().style.touchAction).toBe("pan-y");
  });

  it("résiste au bord plutôt que de partir dans le vide", () => {
    render(<Harness index={0} count={3} onIndexChange={vi.fn()} />);
    down();
    move(300); // on tire vers la droite alors qu'on est déjà au premier
    expect(dx()).toBeGreaterThan(0);
    expect(dx()).toBeLessThan(100);
  });

  it("ne sort pas de la liste au relâchement, même lancée fort", () => {
    const onIndexChange = vi.fn();
    render(<Harness index={2} count={3} onIndexChange={onIndexChange} />);
    down();
    move(20);
    up(20);
    expect(onIndexChange).not.toHaveBeenCalled();
  });
});
