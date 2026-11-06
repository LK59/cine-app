// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ANSWER_TIMEOUT_MS,
  RELOAD_GRACE_MS,
  afterForegroundCheck,
  currentForegroundReturn,
  enableForegroundGate,
  foregroundHeld,
  onForegroundRelease,
  settleForegroundReturn,
} from "@/lib/foregroundGate";

/**
 * La porte du retour au premier plan (DECISIONS.md §134) : la question de version d'abord, les
 * relectures ensuite — jamais pour une page qui se recharge.
 */

let visibility: DocumentVisibilityState = "hidden";
let disable: () => void = () => {};

function show(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "hidden";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  disable();
  disable = () => {};
  vi.useRealTimers();
});

describe("foregroundGate", () => {
  it("armée avant les écouteurs du document, quel que soit leur ordre d'inscription", () => {
    const seen: boolean[] = [];
    // Inscrit AVANT la porte : il la voit quand même armée.
    const early = () => seen.push(foregroundHeld());
    document.addEventListener("visibilitychange", early);
    disable = enableForegroundGate(() => true);
    show("visible");
    document.removeEventListener("visibilitychange", early);
    expect(seen).toEqual([true]);
  });

  it("même build : ce qui attendait part à la réponse, pas avant", () => {
    disable = enableForegroundGate(() => true);
    const released = vi.fn();
    const stop = onForegroundRelease(released);
    show("visible");
    const ran = vi.fn();
    afterForegroundCheck(ran);
    expect(ran).not.toHaveBeenCalled();
    settleForegroundReturn(currentForegroundReturn(), "go");
    expect(ran).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    expect(foregroundHeld()).toBe(false);
    stop();
  });

  it("page qui se recharge : rien ne part — sauf si elle est toujours là bien après", () => {
    disable = enableForegroundGate(() => true);
    show("visible");
    const ran = vi.fn();
    afterForegroundCheck(ran);
    settleForegroundReturn(currentForegroundReturn(), "reloading");
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS * 2);
    expect(ran).not.toHaveBeenCalled();
    expect(foregroundHeld()).toBe(true);
    vi.advanceTimersByTime(RELOAD_GRACE_MS);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(foregroundHeld()).toBe(false);
  });

  it("sans réponse (hors ligne, serveur qui redémarre) : tout part au bout du délai", () => {
    disable = enableForegroundGate(() => true);
    show("visible");
    const ran = vi.fn();
    afterForegroundCheck(ran);
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS - 1);
    expect(ran).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("un rechargement impossible au retour (film ouvert…) : rien n'attend", () => {
    disable = enableForegroundGate(() => false);
    show("visible");
    expect(foregroundHeld()).toBe(false);
    expect(currentForegroundReturn()).toBeNull();
    const ran = vi.fn();
    afterForegroundCheck(ran);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("sans porte branchée, rien n'attend", () => {
    show("visible");
    const ran = vi.fn();
    afterForegroundCheck(ran);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("repartie en arrière-plan avant la réponse : ce qui attendait est oublié, une réponse périmée ne change rien", () => {
    disable = enableForegroundGate(() => true);
    show("visible");
    const first = currentForegroundReturn();
    const ran = vi.fn();
    afterForegroundCheck(ran);
    show("hidden");
    expect(foregroundHeld()).toBe(false);
    show("visible");
    settleForegroundReturn(first, "go");
    expect(foregroundHeld()).toBe(true);
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);
    expect(ran).not.toHaveBeenCalled();
  });
});
