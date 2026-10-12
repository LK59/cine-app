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
