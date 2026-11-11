// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";

/**
 * « À l'écran » (DECISIONS.md §138) rend toujours la main (chasse aux défauts du 11/11/2026) :
 * - un démontage pendant une tenue appelle `onRelease` une fois — le parent retire la rangée dès que la scène
 *   n'a plus de personne nommée, et les commandes, tenues par `onHold`, restaient sur le film ;
 * - la fin d'un appui est entendue où qu'elle ait lieu — relâché hors de la rangée, ou avalé par le menu
 *   contextuel d'un clic droit, l'appui ne finissait jamais : la rangée restait figée sur ses visages.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr" }),
}));

import { PlayerOnScreen, ONSCREEN_SETTLE_MS } from "@/components/playerControls/PlayerOnScreen";
import type { XrayPlayerPerson } from "@/lib/xray/scenes";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const person = (personId: number, name: string): XrayPlayerPerson => ({ personId, name, character: "", photo: null, screenTime: 10, confidence: 0.9 });
const A = [person(1, "Leonardo DiCaprio"), person(2, "Elliot Page")];
const B = [person(4, "Tom Hardy"), person(5, "Ken Watanabe")];
const ids = (c: ParentNode) => Array.from(c.querySelectorAll("[data-onscreen-person]")).map((el) => Number(el.getAttribute("data-onscreen-person")));

describe("un démontage pendant une tenue rend la main", () => {
  it("glisser, lâcher, la rangée retirée dans les 600 ms : `onRelease` une fois, pas deux", () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const onRelease = vi.fn();
    const { container, unmount } = render(<PlayerOnScreen people={A} visible onPick={() => {}} onHold={onHold} onRelease={onRelease} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    fireEvent.touchStart(row);
    fireEvent.scroll(row);
    fireEvent.touchEnd(row);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS - 100));
    expect(onRelease).not.toHaveBeenCalled();
    // Une coupe vers un plan sans visage : le parent démonte la rangée.
    unmount();
    expect(onRelease).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS * 3));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("démontée sous le doigt aussi ; sans geste, ou après la relance, rien de plus", () => {
    vi.useFakeTimers();
    const onRelease = vi.fn();
    const first = render(<PlayerOnScreen people={A} visible onPick={() => {}} onHold={() => {}} onRelease={onRelease} />);
    fireEvent.pointerDown(first.container.querySelector("[data-onscreen-row]")!);
    first.unmount();
    expect(onRelease).toHaveBeenCalledTimes(1);
    // Les écouteurs de la fenêtre sont partis avec elle.
    fireEvent.pointerUp(window);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS * 2));
    expect(onRelease).toHaveBeenCalledTimes(1);

    onRelease.mockClear();
    render(<PlayerOnScreen people={A} visible onPick={() => {}} onRelease={onRelease} />).unmount();
    expect(onRelease).not.toHaveBeenCalled();

    const third = render(<PlayerOnScreen people={A} visible onPick={() => {}} onRelease={onRelease} />);
    const row = third.container.querySelector("[data-onscreen-row]")!;
    fireEvent.pointerDown(row);
    fireEvent.pointerUp(row);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS + 10));
    expect(onRelease).toHaveBeenCalledTimes(1);
    third.unmount();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});

describe("la fin d'un appui, où qu'elle ait lieu", () => {
  it("un appui sur une pilule relâché hors de la rangée : la rangée se relâche et rattrape la scène", () => {
    vi.useFakeTimers();
    const onRelease = vi.fn();
    const { container, rerender } = render(<PlayerOnScreen people={A} visible onPick={() => {}} onRelease={onRelease} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    fireEvent.pointerDown(container.querySelector('[data-onscreen-person="1"]')!);
    expect(row.hasAttribute("data-onscreen-touching")).toBe(true);
    rerender(<PlayerOnScreen people={B} visible onPick={() => {}} onRelease={onRelease} />);
    expect(ids(container)).toEqual([1, 2]);
    // Le bouton relâché ailleurs sur la page : la rangée ne le reçoit pas.
    fireEvent.pointerUp(document.body);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS + 10));
    expect(row.hasAttribute("data-onscreen-touching")).toBe(false);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(ids(container)).toEqual([4, 5]);
    // L'appui fini, la fenêtre ne l'écoute plus : un autre relâchement ne relance rien.
    fireEvent.pointerUp(document.body);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS + 10));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("un clic droit : le menu contextuel avale le `pointerup`, le `contextmenu` termine l'appui", () => {
    vi.useFakeTimers();
    const onRelease = vi.fn();
    const { container } = render(<PlayerOnScreen people={A} visible onPick={() => {}} onRelease={onRelease} />);
    const row = container.querySelector("[data-onscreen-row]")!;
    fireEvent.pointerDown(row, { button: 2 });
    fireEvent.contextMenu(row);
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS + 10));
    expect(row.hasAttribute("data-onscreen-touching")).toBe(false);
    expect(onRelease).toHaveBeenCalledTimes(1);
    // Et la molette y relance de nouveau un geste entier.
    Object.defineProperty(row, "scrollWidth", { value: 900, configurable: true });
    Object.defineProperty(row, "clientWidth", { value: 300, configurable: true });
    fireEvent.wheel(row, { deltaY: 40 });
    act(() => void vi.advanceTimersByTime(ONSCREEN_SETTLE_MS + 10));
    expect(onRelease).toHaveBeenCalledTimes(2);
  });
});
