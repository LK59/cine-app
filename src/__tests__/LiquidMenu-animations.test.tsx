// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createRef } from "react";
import { LiquidMenu } from "@/components/player/LiquidMenu";

// Ce que l'ouverture demande au navigateur. La découpe ne se joue que sur le fil principal (60 i/s
// au plus sous Safari) : séparée d'elle, la transformation partait au compositeur à 120 i/s, et les
// bords de la boîte et son contenu n'avançaient plus au même rythme (8.15.7, 07/10/2026). Tout ce
// qui bouge le fait donc dans une seule animation ; le contenu, lui, ne fait que des fondus.
type Call = { el: Element; keyframes: Keyframe[] };
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  const fake = () => ({ finished: Promise.resolve(), cancel() {}, id: "" });
  HTMLElement.prototype.animate = vi.fn(function (this: Element, keyframes: Keyframe[]) {
    calls.push({ el: this, keyframes });
    return fake() as unknown as Animation;
  }) as unknown as typeof HTMLElement.prototype.animate;
  HTMLElement.prototype.getAnimations = () => [];
  // La liste a de la hauteur : ses lignes visibles s'animent (jsdom ne met rien en page).
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 280 });
  for (const k of ["offsetWidth", "offsetHeight"]) {
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => (k === "offsetWidth" ? 150 : 44) });
  }
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  for (const k of ["offsetWidth", "offsetHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
});

function Menu() {
  const menuRef = createRef<HTMLDivElement>();
  const anchorRef = createRef<HTMLDivElement>();
  return (
    <div style={{ position: "relative" }}>
      <div ref={anchorRef}>
        <button>a</button>
      </div>
      <LiquidMenu menuRef={menuRef} anchorRef={anchorRef} view="audio" title="Audio" icon={<span />} className="player-menu" style={{}} onClick={() => {}} onClickCapture={() => {}}>
        <button>Français</button>
        <button>English</button>
      </LiquidMenu>
    </div>
  );
}

const moves = (k: Keyframe) => "clipPath" in k || "transform" in k;

describe("LiquidMenu — ouverture", () => {
  it("anime la découpe et la forme de la boîte dans une seule animation, d'un même pas", () => {
    render(<Menu />);
    const box = document.querySelector(".player-menu")!;
    const onBox = calls.filter((c) => c.el === box);
    expect(onBox).toHaveLength(1);
    expect(onBox[0].keyframes.every((k) => "clipPath" in k && "transform" in k)).toBe(true);
  });

  it("ne déplace rien à l'intérieur de la boîte : icône, titre et lignes apparaissent en fondu", () => {
    render(<Menu />);
    const box = document.querySelector(".player-menu")!;
    const inside = calls.filter((c) => c.el !== box && box.contains(c.el));
    expect(inside.length).toBeGreaterThanOrEqual(4); // icône, titre, deux lignes
    for (const c of inside) expect(c.keyframes.some(moves)).toBe(false);
  });

  it("la fermeture (copie qui se referme) anime découpe et forme ensemble", () => {
    const { unmount } = render(<Menu />);
    calls = [];
    unmount();
    const shaped = calls.filter((c) => c.keyframes.some((k) => "clipPath" in k));
    expect(shaped).toHaveLength(1);
    expect(shaped[0].keyframes.every((k) => "transform" in k)).toBe(true);
  });
});
