// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import { usePanelArrowNav } from "@/lib/usePanelArrowNav";

/**
 * jsdom ne calcule aucune mise en page : tous les rectangles y valent zéro, et la géométrie —
 * testée à part dans `panelArrowNav` — ne peut pas l'être ici. Ce qui se vérifie ici est l'autre
 * moitié : ce que le crochet accepte d'intercepter, et ce qu'il rend à la page.
 */
function Panel({ withInput = false }: { withInput?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  usePanelArrowNav(ref);
  return (
    <div ref={ref} data-testid="panel">
      {withInput && <input aria-label="champ" />}
      <button data-nav-item>un</button>
      <button data-nav-item>deux</button>
      <button>hors grille</button>
    </div>
  );
}

afterEach(cleanup);

describe("usePanelArrowNav", () => {
  it("moves the focus into the grid on the first arrow", () => {
    render(<Panel />);
    fireEvent.keyDown(screen.getByTestId("panel"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("un"));
  });

  // La garde qui compte : dans un champ, les flèches déplacent le curseur, et les intercepter
  // casserait un geste que tout le monde connaît.
  it("keeps its hands off the arrows while someone is typing", () => {
    render(<Panel withInput />);
    const field = screen.getByLabelText("champ");
    field.focus();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(document.activeElement).toBe(field);
  });

  it("leaves other keys and modified arrows alone", () => {
    render(<Panel />);
    const panel = screen.getByTestId("panel");
    fireEvent.keyDown(panel, { key: "a" });
    fireEvent.keyDown(panel, { key: "ArrowDown", metaKey: true });
    expect(document.activeElement).toBe(document.body);
  });

  // Rendre la touche compte autant que la prendre : au bord d'une grille, elle doit repartir à la
  // page, qui la traduit en défilement.
  it("does not swallow an arrow it cannot act on", () => {
    render(<Panel />);
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    screen.getByTestId("panel").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores what was not marked as part of the grid", () => {
    render(<Panel />);
    const outsider = screen.getByText("hors grille");
    outsider.focus();
    fireEvent.keyDown(outsider, { key: "ArrowDown" });
    // Rien de focalisé *dans* la grille : la flèche y entre par le premier élément.
    expect(document.activeElement).toBe(screen.getByText("un"));
  });

  it("does nothing at all in a panel with no grid", () => {
    function Empty() {
      const ref = useRef<HTMLDivElement>(null);
      usePanelArrowNav(ref);
      return <div ref={ref} data-testid="vide" />;
    }
    render(<Empty />);
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    screen.getByTestId("vide").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("stops listening when it goes away", () => {
    const { unmount } = render(<Panel />);
    const spy = vi.spyOn(HTMLElement.prototype, "focus");
    unmount();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
