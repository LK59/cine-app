// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { useRef } from "react";
import { useLiquidLens, lensTransform } from "@/lib/liquidGlass/useLiquidLens";

afterEach(cleanup);

function Bar({ active, onPick }: { active: string; onPick?: (key: string) => void }) {
  const barRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLSpanElement>(null);
  useLiquidLens({ barRef, lensRef, active });
  return (
    <div ref={barRef}>
      <span ref={lensRef} data-testid="lens" />
      {["a", "b", "c"].map((key, i) => (
        <button
          key={key}
          data-lens={key}
          data-testid={key}
          onClick={() => onPick?.(key)}
          ref={(el) => {
            if (!el) return;
            Object.defineProperty(el, "offsetLeft", { value: i * 64, configurable: true });
            Object.defineProperty(el, "offsetTop", { value: 0, configurable: true });
            Object.defineProperty(el, "offsetWidth", { value: 60, configurable: true });
          }}
        />
      ))}
    </div>
  );
}

/**
 * 04/10/2026 : au changement d'onglet, la pastille repartait vers l'onglet quitté avant d'être
 * recalée sur le bon — l'actif était lu dans une référence mise à jour après l'effet qui la pose.
 */
describe("la lentille d'une barre", () => {
  it("se pose sur le nouvel onglet actif dès le rendu qui le change, jamais sur l'ancien", () => {
    const { getByTestId, rerender } = render(<Bar active="a" />);
    const lens = getByTestId("lens");
    expect(lens.style.transform).toBe(lensTransform(0, 0, "x", 1, 0));
    rerender(<Bar active="c" />);
    expect(lens.style.transform).toBe(lensTransform(128, 0, "x", 1, 0));
    rerender(<Bar active="b" />);
    expect(lens.style.transform).toBe(lensTransform(64, 0, "x", 1, 0));
  });
});

// 04/10/2026 : la bascule Films/Séries choisit au clic, qui arrive après le relâchement — la pastille
// revenait un instant vers l'onglet quitté avant que le clic ne la renvoie sur le bon.
describe("la lentille d'une barre qui choisit au clic", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "animate", {
      value: () => ({ id: "", cancel() {}, finished: Promise.resolve() }),
      configurable: true,
    });
    Object.defineProperty(HTMLElement.prototype, "getAnimations", { value: () => [], configurable: true });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
    vi.useRealTimers();
  });

  it("reste sur l'onglet touché au relâchement, sans repasser par l'ancien", () => {
    const { getByTestId, rerender } = render(<Bar active="a" />);
    const lens = getByTestId("lens");
    fireEvent.pointerDown(getByTestId("b"), { pointerId: 1, button: 0, pointerType: "touch", clientX: 90, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 90, clientY: 10 });
    // Le clic n'est pas encore arrivé : la pastille est déjà sur « b ».
    expect(lens.style.transform).toBe(lensTransform(64, 0, "x", 1, 0));
    rerender(<Bar active="b" />);
    expect(lens.style.transform).toBe(lensTransform(64, 0, "x", 1, 0));
  });

  it("revient sur l'onglet actif si aucun clic ne l'a choisi", () => {
    vi.useFakeTimers();
    const { getByTestId } = render(<Bar active="a" />);
    const lens = getByTestId("lens");
    fireEvent.pointerDown(getByTestId("c"), { pointerId: 2, button: 0, pointerType: "touch", clientX: 150, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 150, clientY: 10 });
    expect(lens.style.transform).toBe(lensTransform(128, 0, "x", 1, 0));
    act(() => void vi.advanceTimersByTime(600));
    expect(lens.style.transform).toBe(lensTransform(0, 0, "x", 1, 0));
  });
});
