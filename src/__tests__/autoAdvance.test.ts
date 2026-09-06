import { describe, it, expect, beforeEach, vi } from "vitest";
import { noteAutoAdvance, noteViewerPresent, autoAdvanceStore, STILL_THERE_AFTER } from "@/lib/autoAdvance";

beforeEach(() => noteViewerPresent());

describe("autoAdvance", () => {
  it("counts episodes that chained on their own", () => {
    expect(autoAdvanceStore.snapshot()).toBe(0);
    noteAutoAdvance();
    noteAutoAdvance();
    expect(autoAdvanceStore.snapshot()).toBe(2);
  });

  // Le seuil est ce qui décide d'interrompre : trois épisodes sans un geste, on demande.
  it("reaches the threshold after three", () => {
    for (let i = 0; i < STILL_THERE_AFTER; i++) noteAutoAdvance();
    expect(autoAdvanceStore.snapshot()).toBeGreaterThanOrEqual(STILL_THERE_AFTER);
  });

  it("starts over the moment someone is there", () => {
    noteAutoAdvance();
    noteAutoAdvance();
    noteViewerPresent();
    expect(autoAdvanceStore.snapshot()).toBe(0);
  });

  // « Quelqu'un est là » est appelé au moindre mouvement de pointeur : prévenir à chaque appel
  // ferait redessiner les commandes à la fréquence de la souris pour répéter la même valeur.
  it("only tells its listeners when the count actually changed", () => {
    const listener = vi.fn();
    const stop = autoAdvanceStore.subscribe(listener);

    noteViewerPresent();
    noteViewerPresent();
    expect(listener).not.toHaveBeenCalled();

    noteAutoAdvance();
    expect(listener).toHaveBeenCalledTimes(1);

    noteViewerPresent();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops telling a listener that has gone", () => {
    const listener = vi.fn();
    autoAdvanceStore.subscribe(listener)();
    noteAutoAdvance();
    expect(listener).not.toHaveBeenCalled();
  });
});
