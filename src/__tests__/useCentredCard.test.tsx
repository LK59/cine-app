// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useCentredCard } from "@/lib/useCentredCard";

/**
 * Le geste tactile de la bannière : la carte arrêtée au centre prend le focus.
 *
 * jsdom ne met en page rien du tout — toutes les positions y valent zéro — donc les largeurs et
 * les décalages sont posés à la main. C'est acceptable ici parce que ce qu'on vérifie n'est pas
 * une mise en page mais un choix : quelle carte, et à quel moment.
 */
function place(el: HTMLElement, left: number, width: number) {
  Object.defineProperty(el, "offsetLeft", { value: left, configurable: true });
  Object.defineProperty(el, "offsetWidth", { value: width, configurable: true });
}

function Grille({ scrollLeft }: { scrollLeft: number }) {
  const pane = useRef<HTMLDivElement>(null);
  useCentredCard(pane, true);
  return (
    <div ref={pane} data-testid="pane">
      <div data-tv-rowroot>
        <div data-testid="row">
          {[0, 1, 2, 3].map((i) => (
            <button key={i} data-tv-card data-tv-col={i} data-testid={`c${i}`} />
          ))}
        </div>
      </div>
      <span hidden>{scrollLeft}</span>
    </div>
  );
}

describe("useCentredCard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function monter() {
    const r = render(<Grille scrollLeft={0} />);
    const row = r.getByTestId("row");
    Object.defineProperty(row, "clientWidth", { value: 400, configurable: true });
    [0, 1, 2, 3].forEach((i) => place(r.getByTestId(`c${i}`), i * 200, 200));
    return { r, row };
  }

  it("donne le focus à la carte la plus proche du centre une fois la rangée arrêtée", () => {
    const { r, row } = monter();
    row.scrollLeft = 400; // centre de la rangée : 600 → la carte 2 (500..700).
    row.dispatchEvent(new Event("scroll", { bubbles: false }));
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(r.getByTestId("c2"));
  });

  it("ne bouge pas pendant le défilement — seulement après l'arrêt", () => {
    const { r, row } = monter();
    row.scrollLeft = 200;
    row.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(100);
    expect(document.activeElement).not.toBe(r.getByTestId("c1"));
    // Le geste continue : l'échéance repart de zéro, et seule la position finale compte.
    row.scrollLeft = 400;
    row.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(100);
    expect(document.body.contains(document.activeElement)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(r.getByTestId("c2"));
  });

  it("ne fait rien quand il est désarmé — la souris garde la main", () => {
    function Souris() {
      const pane = useRef<HTMLDivElement>(null);
      useCentredCard(pane, false);
      return (
        <div ref={pane}>
          <div data-tv-rowroot>
            <div data-testid="row">
              <button data-tv-card data-tv-col={0} data-testid="c0" />
            </div>
          </div>
        </div>
      );
    }
    const r = render(<Souris />);
    r.getByTestId("row").dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(500);
    expect(document.activeElement).toBe(document.body);
  });
});
