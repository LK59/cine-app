import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Sur Chromium, une construction de segment de plus de 50 ms sur le fil principal est *aussi* une
// tâche longue, rapportée aux mêmes instants. Le verdict additionnait les deux : 30 % de calcul
// réel lu comme 60 %, donc « calcul » — précisément sur Chrome Android, pour lequel `diag` existe.
// Le calcul d'une fenêtre est l'union de ses intervalles, pas leur somme.

let clock = 0;
let observerCallback: ((list: { getEntries: () => { startTime: number; duration: number }[] }) => void) | null = null;

beforeEach(() => {
  clock = 1_000;
  vi.resetModules();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  class FakeObserver {
    static supportedEntryTypes = ["longtask"];
    constructor(cb: typeof observerCallback) {
      observerCallback = cb;
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("PerformanceObserver", FakeObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("playbackDiagnosis : un segment qui est aussi une tâche longue", () => {
  it("n'est compté qu'une fois dans le verdict d'une ligne stall", async () => {
    const d = await import("@/lib/webcodecs/playbackDiagnosis");
    d.diagBegin("s1");
    clock = 20_000;
    d.diagInterval("segment", 11_000);
    observerCallback!({ getEntries: () => [{ startTime: 11_000, duration: 9_000 }] });
    clock = 31_000;
    const facts = d.diagStallFacts(0.1);
    // 9 s de calcul sur 30 : ni « calcul », ni rien d'autre qu'on mesure.
    expect(facts.verdict).toBe("autre");
    // Les chiffres bruts, eux, restent ce que chaque étage a mesuré.
    expect(facts.buildMs).toBe(9_000);
    expect(facts.longTaskMs).toBe(9_000);
    d.diagEnd("s1");
  });

  it("n'est compté qu'une fois dans le classement des attentes de la séance", async () => {
    const d = await import("@/lib/webcodecs/playbackDiagnosis");
    d.diagBegin("s1");
    // 6 s de segments, tous tâches longues, dans les 10 s qui précèdent une attente de 2 s : 6 s
    // sur 12, soit 50 %, compté deux fois ; 6 s d'union sur 12 ne l'est qu'une.
    clock = 10_000;
    d.diagInterval("segment", 5_000);
    observerCallback!({ getEntries: () => [{ startTime: 5_000, duration: 5_000 }] });
    clock = 11_000;
    d.diagWaitStarted(0.1);
    clock = 13_000;
    d.diagWaitEnded();
    const facts = d.diagSessionFacts();
    expect(facts.waitsCpu).toBeUndefined();
    expect(facts.waitsOther).toBe(1);
    d.diagEnd("s1");
  });

  it("garde la construction hors attente d'octets et les envois qui ne se chevauchent pas", async () => {
    const d = await import("@/lib/webcodecs/playbackDiagnosis");
    d.diagBegin("s1");
    // 10 s de segment dont 2 s de lecture, une tâche longue de 3 s dans le segment, 6 s d'envoi
    // à part : 8 + 6 = 14 s de calcul sur 30, pas 17.
    clock = 13_000;
    d.diagInterval("read", 11_000);
    clock = 19_000;
    d.diagInterval("segment", 9_000);
    observerCallback!({ getEntries: () => [{ startTime: 14_000, duration: 3_000 }] });
    clock = 25_000;
    d.diagInterval("append", 19_000);
    // Et 2 s de plus, disjointes, font passer le seuil : 16 s sur 30.
    clock = 29_000;
    observerCallback!({ getEntries: () => [{ startTime: 27_000, duration: 2_000 }] });
    clock = 31_000;
    expect(d.diagStallFacts(0.1).verdict).toBe("calcul");
    d.diagEnd("s1");
  });
});
