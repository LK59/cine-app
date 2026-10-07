// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createRef } from "react";
import { LiquidMenu } from "@/components/player/LiquidMenu";

// Ce que l'ouverture demande au navigateur. Une animation qui mêle la découpe (jouée sur le fil
// principal) et la transformation retient celle-ci sur le fil principal avec elle : pendant un film,
// le remultiplexage la faisait saccader (07/10/2026).
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
  for (const k of ["offsetWidth", "offsetHeight"]) {
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => (k === "offsetWidth" ? 150 : 44) });
  }
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  for (const k of ["offsetWidth", "offsetHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
});

function Menu() {
  const menuRef = createRef<HTMLDivElement>();
  const anchorRef = createRef<HTMLDivElement>();
  const originRef = createRef<HTMLButtonElement>();
  return (
    <div style={{ position: "relative" }}>
      <div ref={anchorRef}>
        <button ref={originRef}>a</button>
      </div>
      <LiquidMenu menuRef={menuRef} anchorRef={anchorRef} originRef={originRef} view="audio" title="Audio" icon={<span />} className="player-menu" style={{}} onClick={() => {}} onClickCapture={() => {}}>
        <button>Français</button>
        <button>English</button>
      </LiquidMenu>
    </div>
  );
}

describe("LiquidMenu — ouverture", () => {
  it("joue la découpe et la transformation de la boîte dans deux animations distinctes", () => {
    render(<Menu />);
    const box = document.querySelector(".player-menu")!;
    const onBox = calls.filter((c) => c.el === box);
    expect(onBox.some((c) => c.keyframes.some((k) => "clipPath" in k))).toBe(true);
    expect(onBox.some((c) => c.keyframes.some((k) => "transform" in k))).toBe(true);
    for (const c of onBox) {
      const mixes = c.keyframes.some((k) => "clipPath" in k) && c.keyframes.some((k) => "transform" in k);
      expect(mixes).toBe(false);
    }
  });

  it("la fermeture (copie qui se referme) sépare elle aussi découpe et forme", () => {
    const { unmount } = render(<Menu />);
    calls = [];
    unmount();
    for (const c of calls) {
      const mixes = c.keyframes.some((k) => "clipPath" in k) && c.keyframes.some((k) => "transform" in k);
      expect(mixes).toBe(false);
    }
    expect(calls.some((c) => c.keyframes.some((k) => "clipPath" in k))).toBe(true);
  });
});
