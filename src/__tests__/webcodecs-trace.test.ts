import { describe, it, expect, beforeEach } from "vitest";
import { trace, traceRecent, traceReset, traceText } from "@/lib/webcodecs/trace";

// The record a report is built from. What matters is that a fault two hours into a film still
// has its own context — and that the opening, which is what says how the film was ever playing,
// is never the part that gets thrown away.

beforeEach(() => traceReset());

describe("la trace", () => {
  it("garde tout d'une lecture ordinaire", () => {
    for (let i = 0; i < 50; i++) trace(`étape ${i}`);
    expect(traceText()).toContain("étape 0");
    expect(traceText()).toContain("étape 49");
    expect(traceText()).not.toContain("retirées");
  });

  it("garde l'ouverture et le présent, et jette le milieu", () => {
    // Truncating instead — which is what this did at three hundred steps — meant a film that ran
    // long simply stopped recording, so the fault worth reading about was the one guaranteed to
    // be missing.
    for (let i = 0; i < 3000; i++) trace(`étape ${i}`);
    const text = traceText();

    expect(text).toContain("étape 0"); // how the film opened
    expect(text).toContain("étape 2999"); // what just happened
    expect(text).not.toContain("étape 1500"); // the middle of a long, uneventful run
    expect(text).toContain("retirées");
  });

  it("dit combien de marches manquent plutôt que de laisser un trou", () => {
    // The count and what is left must add up to what happened: a record that loses steps
    // without saying how many is a record nobody can reason about.
    for (let i = 0; i < 1000; i++) trace(`étape ${i}`);
    const text = traceText();
    const missing = Number(/⋯\s+(\d+) étapes/.exec(text)![1]);
    const kept = text.split("\n").length - 1; // every line but the one announcing the gap
    expect(missing + kept).toBe(1000);
  });

  it("ne recopie pas la trace à chaque marche une fois pleine", () => {
    // Trimmed from the middle in batches, so a long run costs one splice every few hundred
    // steps rather than one per step — this loop is the hot path of every seek and every append.
    const at = Date.now();
    for (let i = 0; i < 20000; i++) trace(`étape ${i}`);
    expect(Date.now() - at).toBeLessThan(1000);
  });
});

describe("traceRecent", () => {
  it("rend les étapes d'une fenêtre récente, datées depuis son début, et seulement elles", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      trace("avant le changement");
      vi.setSystemTime(1_010_000);
      trace("changement de piste : A_DTS → A_FLAC");
      vi.setSystemTime(1_012_500);
      trace("changement de piste : piste ouverte");
      vi.setSystemTime(1_014_700);
      // La fenêtre du changement : ses 4,7 dernières secondes.
      expect(traceRecent(4700)).toEqual([
        "+0 ms changement de piste : A_DTS → A_FLAC",
        "+2500 ms changement de piste : piste ouverte",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("borne le nombre d'étapes et leur longueur", () => {
    for (let i = 0; i < 100; i++) trace(`étape ${i} ${"x".repeat(500)}`);
    const recent = traceRecent(60_000, 40, 140);
    expect(recent).toHaveLength(40);
    expect(recent[39]).toContain("étape 99");
    for (const line of recent) expect(line.length).toBeLessThan(160);
  });
});
