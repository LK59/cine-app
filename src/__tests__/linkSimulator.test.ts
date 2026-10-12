// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  armLinkSimulator,
  disarmLinkSimulator,
  resetLinkSimulator,
  setSimulatedLink,
  simulateRequestGate,
  simulateTransfer,
  simulatorActive,
} from "@/lib/linkSimulator";

// Le simulateur de connexion de la page de test (DECISIONS.md §78) : inerte hors de la page, et quand
// il est armé, un débit respecté à ±20 %, des coupures qui échouent comme le réseau.

beforeEach(() => resetLinkSimulator());
afterEach(() => vi.useRealTimers());

describe("le simulateur de connexion", () => {
  it("inactif par défaut — et même avec l'indicateur d'onglet seul, sans la page qui l'arme", () => {
    expect(simulatorActive()).toBe(false);
    sessionStorage.setItem("cine:link-simulator", "1");
    expect(simulatorActive()).toBe(false);
    armLinkSimulator();
    expect(simulatorActive()).toBe(true);
    disarmLinkSimulator();
    expect(simulatorActive()).toBe(false);
    expect(sessionStorage.getItem("cine:link-simulator")).toBeNull();
  });

  it("respecte le débit choisi à ±20 % : 1 Mo à 8 Mbit/s ≈ 1 s", async () => {
    vi.useFakeTimers();
    armLinkSimulator();
    setSimulatedLink({ mbps: 8 });
    let done = false;
    const transfer = simulateTransfer(1_000_000, performance.now()).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(800);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    await transfer;
    expect(done).toBe(true);
  });

  it("coupure totale : la requête échoue comme un réseau tombé ; coupure de 5 s : rétablie seule", () => {
    vi.useFakeTimers();
    armLinkSimulator();
    setSimulatedLink({ cut: true });
    expect(() => simulateRequestGate()).toThrow(TypeError);
    setSimulatedLink({ cut: false, cutForMs: 5000 });
    expect(() => simulateRequestGate()).toThrow(TypeError);
    vi.advanceTimersByTime(5001);
    expect(() => simulateRequestGate()).not.toThrow();
  });
});

// Erreur React #185 à l'ouverture du lot « Connexion simulée » (12/10/2026) : l'instantané lu par
// `useSyncExternalStore` était un objet neuf à chaque appel, et la page se redessinait en boucle.
describe("simulatedLink, instantané stable", () => {
  it("rend le même objet tant que rien ne change, un autre après un réglage", async () => {
    const sim = await import("@/lib/linkSimulator");
    const a = sim.simulatedLink();
    expect(sim.simulatedLink()).toBe(a);
    sim.setSimulatedLink({ mbps: 3 });
    const b = sim.simulatedLink();
    expect(b).not.toBe(a);
    expect(sim.simulatedLink()).toBe(b);
  });
});

// « À 1 Mbit/s tout se lit » (Louis, 12/10/2026) : bridées requête par requête, les lectures en
// parallèle cumulaient leur débit. Un seul lien : deux réponses simultanées se partagent le débit.
describe("un seul lien pour toutes les requêtes", () => {
  it("deux transferts lancés ensemble prennent le temps de deux, pas d'un", async () => {
    vi.useFakeTimers();
    const sim = await import("@/lib/linkSimulator");
    sim.setSimulatedLink({ mbps: 8 }); // 1 Mo/s
    const now = performance.now();
    let done = 0;
    void sim.simulateTransfer(1_000_000, now).then(() => done++);
    void sim.simulateTransfer(1_000_000, now).then(() => done++);
    await vi.advanceTimersByTimeAsync(1100);
    expect(done).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(2);
  });
});
