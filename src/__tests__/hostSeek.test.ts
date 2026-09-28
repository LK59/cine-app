import { describe, it, expect } from "vitest";
import { HostSeek, describeBufferedAround, seekDuration, type SeekTiming } from "@/lib/hostSeek";

// Les sauts vus par l'hôte natif, règle par règle. L'hôte les éprouve de bout en bout
// (ExperimentalPlayerHost.test.tsx : « un changement de piste pendant un saut… », « écrit chaque
// saut au journal… », « écrit un saut remplacé… »).

const timing = (to: number, over: Partial<SeekTiming> = {}): SeekTiming => ({
  from: 100,
  to,
  startedAt: 0,
  hiddenAtStart: 0,
  buffered: false,
  ranges: "vide",
  ...over,
});

describe("la cible demandée", () => {
  it("prime sur ce que dit l'élément tant qu'elle n'est pas atteinte", () => {
    const seeks = new HostSeek();
    seeks.request(600);
    expect(seeks.pending()).toBe(true);
    expect(seeks.intendedPosition({ seeking: true, currentTime: 580 }, 100)).toBe(600);
  });

  it("sans cible : l'élément s'il cherche, sinon la position lue", () => {
    const seeks = new HostSeek();
    expect(seeks.intendedPosition({ seeking: true, currentTime: 580 }, 100)).toBe(580);
    expect(seeks.intendedPosition({ seeking: false, currentTime: 580 }, 100)).toBe(100);
    expect(seeks.intendedPosition(null, 100)).toBe(100);
  });

  it("est oubliée à l'arrivée", () => {
    const seeks = new HostSeek();
    seeks.request(600);
    seeks.seeked(600.2);
    expect(seeks.pending()).toBe(false);
  });

  it("est oubliée quand le moteur dit le saut fini, même tombé ailleurs", () => {
    const seeks = new HostSeek();
    seeks.request(600);
    seeks.seeked(612);
    expect(seeks.pending()).toBe(true);
    seeks.settled(true, false);
    expect(seeks.pending()).toBe(true);
    seeks.settled(false, false);
    expect(seeks.pending()).toBe(false);
  });

  it("posé loin de sa cible et fini selon le moteur : sa mesure est rendue, pour être écrite", () => {
    // 28/09/2026 : un saut vers 0 posé à 12,17 s (son qui commence à 12 s) ne laissait aucune ligne.
    const seeks = new HostSeek();
    seeks.request(0);
    seeks.startMeasure({ from: 5767, to: 0, startedAt: 1, hiddenAtStart: 0 } as never);
    expect(seeks.seeked(12.17)).toBeNull();
    expect(seeks.settled(true, false)).toBeNull();
    expect(seeks.settled(false, false)).toMatchObject({ to: 0 });
    expect(seeks.settled(false, false)).toBeNull();
    expect(seeks.pending()).toBe(false);
  });

  it("au pipeline prêt : rendue si l'ouverture ne l'a pas atteinte, oubliée sinon", () => {
    const seeks = new HostSeek();
    seeks.request(900);
    expect(seeks.consumeAtReady(300)).toBe(900);
    expect(seeks.pending()).toBe(true);
    expect(seeks.consumeAtReady(900.2)).toBeNull();
    expect(seeks.pending()).toBe(false);
  });
});

describe("la mesure d'un saut", () => {
  it("est rendue à l'arrivée, une fois", () => {
    const seeks = new HostSeek();
    seeks.startMeasure(timing(600));
    expect(seeks.seeked(600)).toMatchObject({ to: 600 });
    expect(seeks.seeked(600)).toBeNull();
  });

  it("n'est pas rendue tant que l'élément n'est pas à sa cible", () => {
    const seeks = new HostSeek();
    seeks.startMeasure(timing(600));
    expect(seeks.seeked(200)).toBeNull();
  });

  it("un nouveau saut reprend celle qu'il remplace, avant de commencer la sienne", () => {
    const seeks = new HostSeek();
    expect(seeks.takeMeasure()).toBeNull();
    seeks.startMeasure(timing(600));
    expect(seeks.takeMeasure()).toMatchObject({ to: 600 });
    expect(seeks.takeMeasure()).toBeNull();
  });

  it("ne compte pas le temps passé en arrière-plan", () => {
    // Lancé à 1 000 ms avec 5 000 ms d'arrière-plan déjà cumulés ; à 91 000 ms, 85 000 de plus.
    expect(seekDuration({ startedAt: 1_000, hiddenAtStart: 5_000 }, 91_000, 90_000)).toBe(5_000);
    expect(seekDuration({ startedAt: 1_000, hiddenAtStart: 0 }, 1_500, 0)).toBe(500);
  });

  it("abandonnée hors du chemin natif", () => {
    const seeks = new HostSeek();
    seeks.startMeasure(timing(600));
    seeks.dropMeasure();
    expect(seeks.seeked(600)).toBeNull();
  });
});

describe("le tampon autour d'une cible", () => {
  const ranges = (...spans: [number, number][]) => ({
    length: spans.length,
    start: (i: number) => spans[i][0],
    end: (i: number) => spans[i][1],
  });

  it("dit si la cible y est, et les quatre plages les plus proches dans l'ordre", () => {
    expect(describeBufferedAround(ranges([0, 10], [100, 130], [500, 520], [600, 640], [2000, 2010]), 610)).toEqual({
      buffered: true,
      ranges: "0.0–10.0 · 100.0–130.0 · 500.0–520.0 · 600.0–640.0",
    });
  });

  it("vide, ou rien du tout", () => {
    expect(describeBufferedAround(ranges(), 10)).toEqual({ buffered: false, ranges: "vide" });
    expect(describeBufferedAround(null, 10)).toEqual({ buffered: false, ranges: "vide" });
  });
});
