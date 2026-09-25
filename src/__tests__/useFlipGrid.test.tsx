// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { CATALOGUE_FLIP, useFlipGrid } from "@/lib/useFlipGrid";

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

/**
 * Les rangées du cinéma quand les données fraîches remplacent celles du cache (25/09/2026) : plus de
 * cartes animées, un peu décalées, un fondu au-delà, et le simple changement d'ordre compté.
 */
describe("useFlipGrid — options du catalogue", () => {
  let timings: (KeyframeAnimationOptions | undefined)[] = [];
  beforeEach(() => {
    timings = [];
    HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, frames: Keyframe[], options?: KeyframeAnimationOptions) {
      animations.push({ key: this.dataset.key ?? "grille", frames });
      timings.push(options);
      return {} as Animation;
    }) as unknown as HTMLElement["animate"];
  });

  function Catalogue({ cards, delay = 0 }: { cards: Card[]; delay?: number }) {
    const ref = useRef<HTMLDivElement>(null);
    useFlipGrid(ref, cards.map((c) => c.key), { ...CATALOGUE_FLIP, delayMs: () => delay });
    return (
      <div ref={ref}>
        {cards.map((c) => (
          <div key={c.key} data-key={c.key} data-x={c.x} data-y={c.y} />
        ))}
      </div>
    );
  }
  const line = (keys: string[]) => keys.map((key, i) => ({ key, x: i * 100, y: 0 }));

  it("anime jusqu'à huit changements, chaque carte un peu après la précédente", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const { rerender } = render(<Catalogue cards={line(before)} />);
    // Cinq nouveautés en tête : cinq ajouts, les autres glissent.
    rerender(<Catalogue cards={line(["n1", "n2", "n3", "n4", "n5", ...before])} />);
    expect(animations.length).toBeGreaterThan(5);
    const delays = timings.map((t) => Number(t?.delay ?? 0));
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(timings[1]?.fill).toBe("backwards");
  });

  it("au-delà de huit, fond la rangée entière au lieu de l'agiter", () => {
    const before = ["a", "b", "c", "d", "e"];
    const { rerender } = render(<Catalogue cards={line(before)} />);
    rerender(<Catalogue cards={line(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "a"])} />);
    expect(animations.map((a) => a.key)).toEqual(["grille"]);
    expect(animations[0].frames[0]).toEqual({ opacity: 0 });
  });

  it("ne fond pas un contenu entièrement autre — un onglet, un tri", () => {
    const { rerender } = render(<Catalogue cards={line(["a", "b", "c"])} />);
    rerender(<Catalogue cards={line(["v", "w", "x", "y", "z", "t", "u", "s", "r"])} />);
    expect(animations).toEqual([]);
  });

  it("compte un simple changement d'ordre — le film repris remonte en tête de « Reprendre »", () => {
    const { rerender } = render(<Catalogue cards={line(["a", "b", "c"])} />);
    rerender(<Catalogue cards={line(["c", "a", "b"])} />);
    expect(animations.map((a) => a.key).sort()).toEqual(["a", "b", "c"]);
  });

  it("attend la bannière avant de bouger", () => {
    const { rerender } = render(<Catalogue cards={line(["a", "b"])} delay={250} />);
    rerender(<Catalogue cards={line(["n", "a", "b"])} delay={250} />);
    expect(Number(timings[0]?.delay)).toBe(250);
  });

  it("ne bouge rien quand l'appareil demande moins de mouvement", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const { rerender } = render(<Catalogue cards={line(["a", "b"])} />);
    rerender(<Catalogue cards={line(["n", "a", "b"])} />);
    expect(animations).toEqual([]);
  });

  it("laisse « Ma liste » à trois changements, comme avant", () => {
    // Quatre retraits : au-delà de trois, et pas de fondu sans les options du catalogue.
    const { rerender } = render(<Grid cards={row(["a", "b", "c", "d", "e", "f"])} />);
    rerender(<Grid cards={row(["a", "f"])} />);
    expect(animations).toEqual([]);
  });
});
