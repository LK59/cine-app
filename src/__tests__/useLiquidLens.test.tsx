// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useLiquidLens, lensTransform } from "@/lib/liquidGlass/useLiquidLens";

afterEach(cleanup);

function Bar({ active }: { active: string }) {
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
