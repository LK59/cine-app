// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { useLiquidDelegation } from "@/lib/liquidGlass/useLiquidDelegation";
import { liquidButtonRef } from "@/lib/liquidGlass/liquid";

const animate = vi.fn(() => ({ id: "", cancel() {}, finished: Promise.resolve() }) as unknown as Animation);
beforeEach(() => {
  animate.mockClear();
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });
  Object.defineProperty(HTMLElement.prototype, "getAnimations", { value: () => [], configurable: true });
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
});

function Screen({ show }: { show: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useLiquidDelegation(ref);
  if (!show) return null;
  return (
    <section ref={ref}>
      <button data-liquid-pan="press">Lire</button>
      <button data-liquid-pan="press" disabled>
        Indisponible
      </button>
    </section>
  );
}

describe("le geste liquide par délégation", () => {
  // Une bannière vide au premier rendu (catalogue pas encore là) gagne son élément ensuite.
  it("se branche sur un écran qui n'apparaît qu'au rendu suivant, et ignore un bouton désactivé", () => {
    const { rerender, getByText } = render(<Screen show={false} />);
    rerender(<Screen show />);
    fireEvent.pointerDown(getByText("Lire"), { button: 0, pointerId: 1, pointerType: "touch" });
    expect(animate.mock.contexts.at(-1)).toBe(getByText("Lire"));
    fireEvent.pointerUp(window, { pointerId: 1 });
    animate.mockClear();
    fireEvent.pointerDown(getByText("Indisponible"), { button: 0, pointerId: 2, pointerType: "touch" });
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("une croix branchée par sa référence", () => {
  it("s'anime à l'appui, et plus du tout une fois démontée", () => {
    const { getByRole, unmount } = render(
      <button ref={liquidButtonRef} data-liquid aria-label="Fermer" />,
    );
    const close = getByRole("button");
    fireEvent.pointerDown(close, { button: 0, pointerId: 3, pointerType: "touch" });
    expect(animate.mock.contexts.at(-1)).toBe(close);
    fireEvent.pointerUp(window, { pointerId: 3 });
    unmount();
    animate.mockClear();
    fireEvent.pointerDown(close, { button: 0, pointerId: 4, pointerType: "touch" });
    expect(animate).not.toHaveBeenCalled();
  });
});
