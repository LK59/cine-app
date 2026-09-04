// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { useCarouselDrag, carouselTransform, CAROUSEL_TRANSITION } from "@/lib/useCarouselDrag";

afterEach(() => cleanup());
beforeEach(() => {
  // jsdom ne met rien en page : la largeur de la piste sert à décider du seuil d'engagement.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { value: 400, configurable: true });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  // La peinture est calée sur l'image d'écran : ici on l'exécute tout de suite.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

/**
 * Le nombre de rendus est ce qui compte autant que le comportement : la première version gardait
 * le décalage dans l'état de React et redessinait tout l'écran d'accueil à chaque pixel — cinq
 * images par seconde pour un geste qui ne demande qu'une propriété CSS.
 */
function Harness({
  index,
  count,
  onIndexChange,
  onRender,
  onDragStateChange,
}: {
  index: number;
  count: number;
  onIndexChange: (n: number) => void;
  onRender?: () => void;
  onDragStateChange?: (dragging: boolean) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useCarouselDrag({ trackRef, count, index, onIndexChange, onDragStateChange });
  // Compté depuis un effet : les effets suivent chaque rendu, et rien n'est modifié pendant.
  useEffect(() => {
    onRender?.();
  });
  return (
    <div data-testid="frame" {...drag.handlers} style={drag.style}>
      <div
        data-testid="track"
        ref={trackRef}
        style={{ transform: carouselTransform(index), transition: CAROUSEL_TRANSITION }}
      />
    </div>
  );
}

const frame = () => screen.getByTestId("frame");
const track = () => screen.getByTestId("track");

function down(x = 200, y = 200) {
  fireEvent.pointerDown(frame(), { clientX: x, clientY: y, pointerType: "touch", pointerId: 1 });
}
function move(x: number, y = 200) {
  fireEvent.pointerMove(frame(), { clientX: x, clientY: y, pointerType: "touch", pointerId: 1 });
}
function up(x: number, y = 200) {
  fireEvent.pointerUp(frame(), { clientX: x, clientY: y, pointerType: "touch", pointerId: 1 });
}

describe("la traînée du carrousel", () => {
  it("suit le doigt sans transition, en écrivant sur la piste", () => {
    render(<Harness index={1} count={5} onIndexChange={vi.fn()} />);
    down();
    move(140);
    expect(track().style.transform).toBe(carouselTransform(1, -60));
    expect(track().style.transition).toBe("none");
  });

  it("ne redessine rien pendant le geste", () => {
    const onRender = vi.fn();
    render(<Harness index={1} count={5} onIndexChange={vi.fn()} onRender={onRender} />);
    onRender.mockClear();
    down();
    for (let x = 190; x > 60; x -= 5) move(x);
    expect(onRender).not.toHaveBeenCalled();
  });

  /**
   * Sans le recalcul intermédiaire, le navigateur voit d'un coup une transition active et une
   * transformation déjà changée : il n'a rien à interpoler et pose l'affiche cible d'un trait.
   * C'est la coupure sèche au relâchement.
   */
  it("laisse au navigateur de quoi interpoler avant de poser l'arrivée", () => {
    const seen: string[] = [];
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.testid === "track") seen.push(this.style.transition);
        return 400;
      },
    });
    render(<Harness index={1} count={5} onIndexChange={vi.fn()} />);
    down();
    move(60);
    up(60);
    // La transition est déjà rendue au moment où la mise en page est relue, et la piste est
    // encore là où le doigt l'a laissée.
    expect(seen).toContain(CAROUSEL_TRANSITION);
  });

  it("passe au titre suivant quand on est allé assez loin", () => {
    const onIndexChange = vi.fn();
    render(<Harness index={1} count={5} onIndexChange={onIndexChange} />);
    down();
    move(60); // 140 px sur 400, au-delà du quart
    up(60);
    expect(onIndexChange).toHaveBeenCalledWith(2);
    // Le geste se poursuit sans attendre le rendu de React.
    expect(track().style.transform).toBe(carouselTransform(2));
    expect(track().style.transition).toBe(CAROUSEL_TRANSITION);
  });

  it("revient à sa place quand le geste s'arrête trop tôt", () => {
    const onIndexChange = vi.fn();
    render(<Harness index={1} count={5} onIndexChange={onIndexChange} />);
    down();
    // Vingt pixels : ni la distance (un quart de 400, soit 100) ni le plancher du lancer (24).
    move(180);
    up(180);
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(track().style.transform).toBe(carouselTransform(1));
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
    const initial = track().style.transform;
    down();
    move(196, 60); // surtout vertical : l'axe est concédé
    move(20, 60); // franchement horizontal, mais trop tard
    up(20, 60);
    expect(track().style.transform).toBe(initial);
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("ne réclame que l'axe horizontal au navigateur", () => {
    render(<Harness index={0} count={3} onIndexChange={vi.fn()} />);
    expect(frame().style.touchAction).toBe("pan-y");
  });

  it("résiste au bord plutôt que de partir dans le vide", () => {
    render(<Harness index={0} count={3} onIndexChange={vi.fn()} />);
    down();
    move(300); // on tire vers la droite alors qu'on est déjà au premier
    expect(track().style.transform).toBe(carouselTransform(0, 35));
  });

  it("ne sort pas de la liste au relâchement, même lancée fort", () => {
    const onIndexChange = vi.fn();
    render(<Harness index={2} count={3} onIndexChange={onIndexChange} />);
    down();
    move(20);
    up(20);
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  /**
   * La rotation automatique se déclenchait au milieu d'un geste : elle redessinait tout l'écran
   * *et* remplaçait la transformation écrite à la main par celle du nouvel index — la piste
   * sautait sous le doigt. L'appelant a besoin de le savoir pour la suspendre, mais deux fois
   * par geste, pas cent vingt.
   */
  it("annonce le début et la fin du geste, et rien entre les deux", () => {
    const onDragStateChange = vi.fn();
    render(
      <Harness index={1} count={5} onIndexChange={vi.fn()} onDragStateChange={onDragStateChange} />
    );
    down();
    for (let x = 190; x > 60; x -= 5) move(x);
    expect(onDragStateChange.mock.calls).toEqual([[true]]);
    up(60);
    expect(onDragStateChange.mock.calls).toEqual([[true], [false]]);
  });

  it("ne l'annonce pas pour un geste qui appartient à la page", () => {
    const onDragStateChange = vi.fn();
    render(
      <Harness index={1} count={5} onIndexChange={vi.fn()} onDragStateChange={onDragStateChange} />
    );
    down();
    move(196, 60);
    up(196, 60);
    expect(onDragStateChange).not.toHaveBeenCalled();
  });
});
