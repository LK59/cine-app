// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useRef } from "react";
import { CATALOGUE_LEAVE_MS, ROW_REST_MS, catalogueRanks, interleaveLeaving, useCatalogueRow } from "@/lib/useCatalogueRow";

/**
 * Une rangée du catalogue quand la relecture au premier plan change ses titres (DECISIONS.md §94) :
 * l'arrivée se pose, le départ s'efface sur place puis laisse glisser ses voisines, et rien ne bouge
 * sous la main — défilement, doigt, focus. jsdom ne met rien en page : chaque carte porte sa position
 * dans `data-x`, que `offsetLeft` renvoie.
 */

let animations: { key: string; frames: Keyframe[]; cancelled: boolean }[] = [];
let reduced = false;
beforeEach(() => {
  animations = [];
  reduced = false;
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get() { return Number(this.dataset.x ?? 0); } });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get() { return 0; } });
  HTMLElement.prototype.animate = vi.fn(function (this: HTMLElement, frames: Keyframe[]) {
    const entry = { key: this.dataset.key ?? "", frames, cancelled: false };
    animations.push(entry);
    return { cancel: () => (entry.cancelled = true) } as unknown as Animation;
  }) as unknown as HTMLElement["animate"];
  vi.stubGlobal("matchMedia", () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Title = { id: string };
const keyOf = (t: Title) => t.id;
const titles = (...ids: string[]) => ids.map((id) => ({ id }));

function Row({ items }: { items: Title[] }) {
  const track = useRef<HTMLDivElement>(null);
  const { shown } = useCatalogueRow(track, items, keyOf);
  return (
    <div ref={track} data-testid="piste">
      {shown.map((t, i) => (
        <button key={t.id} data-key={t.id} data-x={i * 100}>
          {t.id}
        </button>
      ))}
    </div>
  );
}

const cards = (container: HTMLElement) => Array.from(container.querySelectorAll("button")).map((b) => b.dataset.key);
const leaves = () => animations.filter((a) => (a.frames[1] as { opacity?: number })?.opacity === 0);
const arrivals = () => animations.filter((a) => (a.frames[0] as { opacity?: number })?.opacity === 0);

describe("useCatalogueRow", () => {
  it("un titre arrivé se pose (opacité et échelle), ses voisines glissent", () => {
    const { rerender } = render(<Row items={titles("a", "b", "c")} />);
    rerender(<Row items={titles("new", "a", "b", "c")} />);
    act(() => vi.advanceTimersByTime(400));
    expect(arrivals().map((a) => a.key)).toEqual(["new"]);
    expect(animations.filter((a) => String(a.frames[0].transform).startsWith("translate")).map((a) => a.key)).toEqual(["a", "b", "c"]);
  });

  it("un titre retiré s'efface sur place, inerte, puis sort ; ses voisines glissent dans le trou", () => {
    const { container, rerender } = render(<Row items={titles("a", "b", "c")} />);
    rerender(<Row items={titles("a", "c")} />);
    // Toujours là, à sa place, le temps de s'effacer — sans pointeur ni focus.
    expect(cards(container)).toEqual(["a", "b", "c"]);
    const leaving = container.querySelector('[data-key="b"]') as HTMLElement;
    expect(leaving.hasAttribute("inert")).toBe(true);
    expect(leaves().map((a) => a.key)).toEqual(["b"]);
    act(() => vi.advanceTimersByTime(CATALOGUE_LEAVE_MS + 400));
    expect(cards(container)).toEqual(["a", "c"]);
    expect(animations.some((a) => a.key === "c" && String(a.frames[0].transform).startsWith("translate(100px"))).toBe(true);
  });

  it("une rangée qu'on fait défiler garde ce qu'elle montre jusqu'à son repos", () => {
    const { container, getByTestId, rerender } = render(<Row items={titles("a", "b", "c")} />);
    act(() => {
      getByTestId("piste").dispatchEvent(new Event("scroll"));
    });
    rerender(<Row items={titles("new", "a", "c")} />);
    expect(cards(container)).toEqual(["a", "b", "c"]);
    expect(animations).toEqual([]);
    // Le défilement continue : toujours rien.
    act(() => {
      vi.advanceTimersByTime(ROW_REST_MS - 50);
      getByTestId("piste").dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(ROW_REST_MS - 50);
    });
    expect(cards(container)).toEqual(["a", "b", "c"]);
    // Au repos : la mise à jour se joue, avec ses animations.
    act(() => vi.advanceTimersByTime(100));
    expect(cards(container)).toEqual(["new", "a", "b", "c"]);
    expect(leaves().map((a) => a.key)).toEqual(["b"]);
    act(() => vi.advanceTimersByTime(CATALOGUE_LEAVE_MS + 400));
    expect(cards(container)).toEqual(["new", "a", "c"]);
  });

  it("une carte qui tient le focus (clavier, télécommande) : la rangée attend qu'il parte", () => {
    const { container, rerender } = render(
      <>
        <Row items={titles("a", "b", "c")} />
        <button data-testid="ailleurs">ailleurs</button>
      </>
    );
    act(() => (container.querySelector('[data-key="b"]') as HTMLElement).focus());
    rerender(
      <>
        <Row items={titles("x", "a", "b", "c")} />
        <button data-testid="ailleurs">ailleurs</button>
      </>
    );
    expect(cards(container).slice(0, 3)).toEqual(["a", "b", "c"]);
    act(() => (container.querySelector('[data-testid="ailleurs"]') as HTMLElement).focus());
    expect(cards(container).slice(0, 4)).toEqual(["x", "a", "b", "c"]);
  });

  it("un doigt posé sur la rangée : rien ne bouge avant qu'il se lève", () => {
    const { container, getByTestId, rerender } = render(<Row items={titles("a", "b")} />);
    act(() => {
      getByTestId("piste").dispatchEvent(new Event("pointerdown"));
    });
    rerender(<Row items={titles("b")} />);
    expect(cards(container)).toEqual(["a", "b"]);
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(leaves().map((a) => a.key)).toEqual(["a"]);
  });

  it("« Réduire les animations » : remplacée telle quelle, sans effacement", () => {
    reduced = true;
    const { container, rerender } = render(<Row items={titles("a", "b", "c")} />);
    rerender(<Row items={titles("a", "c")} />);
    expect(cards(container)).toEqual(["a", "c"]);
    expect(animations).toEqual([]);
  });

  it("un titre revenu avant la fin de son effacement est rendu tel qu'il était", () => {
    const { container, rerender } = render(<Row items={titles("a", "b", "c")} />);
    rerender(<Row items={titles("a", "c")} />);
    const fade = leaves()[0];
    rerender(<Row items={titles("a", "b", "c")} />);
    expect(fade.cancelled).toBe(true);
    act(() => vi.advanceTimersByTime(CATALOGUE_LEAVE_MS + 400));
    expect(cards(container)).toEqual(["a", "b", "c"]);
  });

  it("une liste neuve aux mêmes titres ne redessine rien et n'anime rien", () => {
    const { container, rerender } = render(<Row items={titles("a", "b")} />);
    rerender(<Row items={titles("a", "b")} />);
    expect(cards(container)).toEqual(["a", "b"]);
    expect(animations).toEqual([]);
  });
});

describe("le placement et les rangs", () => {
  it("une carte partante reste après sa dernière voisine restée", () => {
    expect(interleaveLeaving(titles("a", "b", "c", "d"), titles("x", "a", "d"), keyOf).map(keyOf)).toEqual(["x", "a", "b", "c", "d"]);
    expect(interleaveLeaving(titles("a", "b"), titles("b"), keyOf).map(keyOf)).toEqual(["a", "b"]);
  });

  it("le classement compte les cartes qui restent", () => {
    expect(catalogueRanks(titles("a", "b", "c"), new Set(["b"]), keyOf)).toEqual([1, 2, 2]);
  });
});
