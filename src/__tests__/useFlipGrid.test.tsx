// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useFlipGrid } from "@/lib/useFlipGrid";

/**
 * « Ma liste » se réorganise au lieu de sauter (23/09/2026). jsdom ne met rien en page : chaque
 * carte porte sa position dans `data-x` / `data-y`, que les lectures de position renvoient.
 */
let animations: { key: string; frames: Keyframe[] }[] = [];
beforeEach(() => {
  animations = [];
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get() { return Number(this.dataset.x ?? 0); } });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get() { return Number(this.dataset.y ?? 0); } });
  HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
    animations.push({ key: this.dataset.key ?? "", frames });
    return {} as Animation;
  }) as unknown as HTMLElement["animate"];
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Card = { key: string; x: number; y: number };
function Grid({ cards }: { cards: Card[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useFlipGrid(ref, cards.map((c) => c.key));
  return (
    <div ref={ref}>
      {cards.map((c) => (
        <div key={c.key} data-key={c.key} data-x={c.x} data-y={c.y} />
      ))}
    </div>
  );
}
const row = (keys: string[]) => keys.map((key, i) => ({ key, x: (i % 3) * 100, y: Math.floor(i / 3) * 200 }));

describe("useFlipGrid", () => {
  it("n'anime rien au premier affichage", () => {
    render(<Grid cards={row(["a", "b", "c", "d"])} />);
    expect(animations).toEqual([]);
  });

  it("fait glisser les voisines quand une carte est retirée", () => {
    const { rerender } = render(<Grid cards={row(["a", "b", "c", "d"])} />);
    rerender(<Grid cards={row(["a", "c", "d"])} />);
    // c passe de (200,0) à (100,0) : elle part de +100 px ; d remonte d'une ligne.
    expect(animations.map((a) => a.key)).toEqual(["c", "d"]);
    expect(animations[0].frames[0]).toEqual({ transform: "translate(100px, 0px)" });
    expect(animations[1].frames[0]).toEqual({ transform: "translate(-200px, 200px)" });
  });

  it("fait apparaître une carte ajoutée en se posant", () => {
    const { rerender } = render(<Grid cards={row(["a", "b"])} />);
    rerender(<Grid cards={row(["new", "a", "b"])} />);
    expect(animations.find((a) => a.key === "new")?.frames[0]).toMatchObject({ opacity: 0 });
  });

  it("ne bouge rien pour un autre contenu (onglet, tri, filtre)", () => {
    const { rerender } = render(<Grid cards={row(["a", "b", "c", "d"])} />);
    rerender(<Grid cards={row(["w", "x", "y", "z"])} />);
    expect(animations).toEqual([]);
  });

  it("ne bouge rien quand l'appareil demande moins de mouvement", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const { rerender } = render(<Grid cards={row(["a", "b", "c"])} />);
    rerender(<Grid cards={row(["a", "c"])} />);
    expect(animations).toEqual([]);
  });

  it("ne relance rien sur un simple nouveau rendu", () => {
    const { rerender } = render(<Grid cards={row(["a", "b"])} />);
    rerender(<Grid cards={row(["a", "b"])} />);
    expect(animations).toEqual([]);
  });
});
