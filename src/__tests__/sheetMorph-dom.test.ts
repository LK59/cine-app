// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { afterTwoFrames } from "@/lib/sheetMorph/dom";

/**
 * Le départ d'un trajet attend deux images — au plus 50 ms. Sur le moteur de Safari, une page dont
 * les animations sont encore en pause n'a reçu sa première image qu'au bout de ~900 ms (10/10/2026) :
 * la fiche restait figée à son point de départ. Le départ ne doit pas dépendre de cette cadence.
 */
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("afterTwoFrames", () => {
  it("part au plus tard après 50 ms, même si le navigateur ne donne aucune image", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const fn = vi.fn();
    afterTwoFrames(fn);
    vi.advanceTimersByTime(49);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("part dès la deuxième image quand elles viennent, une seule fois", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    const fn = vi.fn();
    afterTwoFrames(fn);
    frames.shift()!(0);
    expect(fn).not.toHaveBeenCalled();
    frames.shift()!(16);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("annulé, ne part jamais", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const fn = vi.fn();
    const cancel = afterTwoFrames(fn);
    cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});
