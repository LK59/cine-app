// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { suppressRise, useRiseIn } from "@/lib/riseIn";

/**
 * Les cartes qui montent rejoindre leur rangée (25/09/2026) : l'image déjà là, la carte qui arrive
 * avec un léger rebond — jamais pour ce qui était déjà à l'écran, ni pour un onglet révélé d'un coup.
 */
type Callback = (entries: { target: Element; isIntersecting: boolean }[]) => void;
let fire: Callback;
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: Callback) {
        fire = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Row() {
  const ref = useRef<HTMLDivElement>(null);
  useRiseIn(ref);
  return (
    <div ref={ref}>
      {["a", "b", "c"].map((k) => (
        <button key={k} data-tv-card data-testid={k} />
      ))}
    </div>
  );
}

function withAnimate(el: HTMLElement) {
  const animate = vi.fn();
  Object.defineProperty(el, "animate", { value: animate, configurable: true });
  return animate;
}

describe("les cartes qui montent", () => {
  it("font monter une carte qui entre dans l'écran après avoir été vue dehors", () => {
    const { getByTestId } = render(<Row />);
    const a = getByTestId("a");
    const animate = withAnimate(a);
    fire([{ target: a, isIntersecting: false }]);
    fire([{ target: a, isIntersecting: true }]);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("laissent tranquille une carte déjà à l'écran à la première observation", () => {
    const { getByTestId } = render(<Row />);
    const b = getByTestId("b");
    const animate = withAnimate(b);
    fire([{ target: b, isIntersecting: true }]);
    expect(animate).not.toHaveBeenCalled();
  });

  it("ne montent qu'une fois, et partent en vague", () => {
    const { getByTestId } = render(<Row />);
    const [a, b] = [getByTestId("a"), getByTestId("b")];
    const [ma, mb] = [withAnimate(a), withAnimate(b)];
    fire([{ target: a, isIntersecting: false }, { target: b, isIntersecting: false }]);
    fire([{ target: a, isIntersecting: true }, { target: b, isIntersecting: true }]);
    fire([{ target: a, isIntersecting: true }]);
    expect(ma).toHaveBeenCalledTimes(1);
    const delays = [ma.mock.calls[0][1].delay, mb.mock.calls[0][1].delay].sort((x, y) => x - y);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(0);
  });

  it("ne rejouent rien quand un changement d'onglet révèle tout un volet", () => {
    const { getByTestId } = render(<Row />);
    const c = getByTestId("c");
    const animate = withAnimate(c);
    fire([{ target: c, isIntersecting: false }]);
    suppressRise();
    fire([{ target: c, isIntersecting: true }]);
    expect(animate).not.toHaveBeenCalled();
  });
});
