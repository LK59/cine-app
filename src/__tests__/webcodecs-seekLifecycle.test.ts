import { describe, it, expect, vi } from "vitest";
import { SeekLifecycle } from "@/lib/webcodecs/seekLifecycle";

// L'état d'un saut, réuni le 22/09/2026 : ses transitions, sans lecteur autour.
describe("SeekLifecycle", () => {
  it("garde la dernière demande d'une rafale, et ne l'oublie qu'une fois servie", () => {
    const seek = new SeekLifecycle();
    seek.request(300);
    seek.request(900);
    expect(seek.requested).toBe(900);
    seek.served(300);
    expect(seek.requested).toBe(900);
    seek.served(900);
    expect(seek.requested).toBeNull();
  });

  it("reconnaît ses propres déplacements, à un quart de seconde près", () => {
    const seek = new SeekLifecycle();
    seek.serving(600);
    expect(seek.isOwnMove(600.2)).toBe(true);
    expect(seek.isOwnMove(601)).toBe(false);
  });

  it("ne reconnaît son propre déplacement qu'une fois, et pas longtemps", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const seek = new SeekLifecycle();
      seek.moved(0.24);
      expect(seek.isOwnMove(0.24)).toBe(true);
      // Pris : un second `seeking` au même endroit est celui du spectateur.
      expect(seek.isOwnMove(0.24)).toBe(false);
      seek.moved(0.24);
      vi.setSystemTime(Date.now() + 60_000);
      // « Revoir », une heure et demie plus tard : c'est le spectateur.
      expect(seek.isOwnMove(0)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("n'arrive qu'à sa cible, et suit un pas volontaire de la source", () => {
    const seek = new SeekLifecycle();
    seek.started(600, 0);
    expect(seek.pending).toBe(true);
    expect(seek.arrive(612)).toBe(false);
    // L'atterrissage l'a posée sur le premier média, douze secondes plus loin.
    seek.moved(612);
    expect(seek.arrive(612)).toBe(true);
    expect(seek.pending).toBe(false);
  });

  it("se laisse abandonner quand la tête est partie ailleurs", () => {
    const seek = new SeekLifecycle();
    seek.started(600, 0);
    seek.drop();
    expect(seek.intent).toBeNull();
    expect(seek.pending).toBe(false);
  });
});

describe("landingFor — un seul atterrissage pour l'ouverture et le saut", () => {
  const ranges = (...spans: [number, number][]) =>
    ({ length: spans.length, start: (i: number) => spans[i][0], end: (i: number) => spans[i][1] }) as unknown as TimeRanges;

  it("reste sur la cible quand le média la couvre", async () => {
    const { landingFor } = await import("@/lib/webcodecs/seekLifecycle");
    expect(landingFor(ranges([595, 630]), 600, 15)).toBe(600);
  });

  it("pose la tête un pas dans le premier média qui suit, jamais sur son premier instant", async () => {
    const { landingFor } = await import("@/lib/webcodecs/seekLifecycle");
    expect(landingFor(ranges([640, 660], [600.3, 620]), 600, 15)).toBeCloseTo(600.34, 5);
    // Une plage plus courte que le pas : juste avant sa fin.
    expect(landingFor(ranges([600.3, 600.32]), 600, 15)).toBe(600.3);
  });

  it("ignore une plage vide", async () => {
    const { landingFor } = await import("@/lib/webcodecs/seekLifecycle");
    expect(landingFor(ranges([600.2, 600.2], [601, 620]), 600, 15)).toBeCloseTo(601.04, 5);
  });

  it("ne va pas chercher au-delà de sa portée, ni en arrière", async () => {
    const { landingFor } = await import("@/lib/webcodecs/seekLifecycle");
    expect(landingFor(ranges([640, 660]), 600, 15)).toBeNull();
    expect(landingFor(ranges([500, 590]), 600, 15)).toBeNull();
  });
});
