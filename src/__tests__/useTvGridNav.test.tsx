// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useTvGridNav } from "@/lib/useTvGridNav";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// jsdom never computes real layout, so getBoundingClientRect always reports zeros — the hook
// relies on it purely to order rows top-to-bottom, so each card is stubbed with the position of
// its own row (col position is irrelevant to that check, only used for column ordering within a
// row, which the hook derives from data-tv-col instead).
function makeCard(row: string, col: number, rowTop: number): HTMLButtonElement {
  const el = document.createElement("button");
  el.dataset.tvCard = "true";
  el.dataset.tvRow = row;
  el.dataset.tvCol = String(col);
  el.getBoundingClientRect = () => ({ top: rowTop } as DOMRect);
  document.body.appendChild(el);
  return el;
}

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key }));
}

describe("useTvGridNav", () => {
  it("ArrowDown from nothing focused jumps into the first card of the first (topmost) row", () => {
    const r2c0 = makeCard("row-b", 0, 100);
    makeCard("row-a", 0, 0); // added second but should sort first (top: 0)
    renderHook(() => useTvGridNav());

    press("ArrowDown");

    // First row is the one with the smaller top, i.e. "row-a" — but since we only asserted
    // r2c0 isn't focused, re-derive the expected element directly for clarity.
    const rowA0 = document.querySelector('[data-tv-row="row-a"][data-tv-col="0"]');
    expect(document.activeElement).toBe(rowA0);
    expect(document.activeElement).not.toBe(r2c0);
  });

  it("ArrowRight moves focus to the next card in the same row, without wrapping past the end", () => {
    const c0 = makeCard("row-a", 0, 0);
    const c1 = makeCard("row-a", 1, 0);
    renderHook(() => useTvGridNav());
    c0.focus();

    press("ArrowRight");
    expect(document.activeElement).toBe(c1);

    press("ArrowRight"); // already last column — stays put
    expect(document.activeElement).toBe(c1);
  });

  it("ArrowLeft moves focus to the previous card, without wrapping before the start", () => {
    const c0 = makeCard("row-a", 0, 0);
    const c1 = makeCard("row-a", 1, 0);
    renderHook(() => useTvGridNav());
    c1.focus();

    press("ArrowLeft");
    expect(document.activeElement).toBe(c0);

    press("ArrowLeft"); // already first column — stays put
    expect(document.activeElement).toBe(c0);
  });

  it("ArrowDown/ArrowUp move between rows, clamping the column to the shorter row's length", () => {
    const topRow0 = makeCard("row-a", 0, 0);
    makeCard("row-a", 1, 0);
    makeCard("row-a", 2, 0);
    const bottomRow0 = makeCard("row-b", 0, 100);
    renderHook(() => useTvGridNav());

    // Start at column 2 of the 3-wide top row, move down into the 1-wide bottom row —
    // should clamp to its only column (0), not throw or land on undefined.
    (document.querySelectorAll('[data-tv-row="row-a"]')[2] as HTMLElement).focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(bottomRow0);

    press("ArrowUp");
    // Clamped back to column 0 of the top row (bottom row only had column 0 to remember).
    expect(document.activeElement).toBe(topRow0);
  });

  it("does nothing when there is no row above/below or left/right to move into", () => {
    const only = makeCard("row-a", 0, 0);
    renderHook(() => useTvGridNav());
    only.focus();

    press("ArrowUp");
    press("ArrowDown");
    press("ArrowLeft");
    press("ArrowRight");

    expect(document.activeElement).toBe(only);
  });

  it("ignores arrow keys entirely while an input/textarea/select is focused", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    makeCard("row-a", 0, 0);
    renderHook(() => useTvGridNav());
    input.focus();

    press("ArrowDown");

    expect(document.activeElement).toBe(input);
  });

  it("ignores non-arrow keys", () => {
    const only = makeCard("row-a", 0, 0);
    renderHook(() => useTvGridNav());
    only.focus();

    press("Enter");

    expect(document.activeElement).toBe(only);
  });

  it("ArrowUp from the top row hands focus to a data-tv-escape-up element, when one exists", () => {
    const escapeTarget = document.createElement("button");
    escapeTarget.dataset.tvEscapeUp = "true";
    document.body.appendChild(escapeTarget);
    const topRow0 = makeCard("row-a", 0, 0);
    renderHook(() => useTvGridNav());
    topRow0.focus();

    press("ArrowUp");

    expect(document.activeElement).toBe(escapeTarget);
  });

  it("removes its keydown listener on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useTvGridNav());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
