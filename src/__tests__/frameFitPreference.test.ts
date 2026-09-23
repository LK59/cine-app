// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => window.localStorage.clear());

// L'instantané est gardé en cache pour `useSyncExternalStore` : chaque cas part d'un module neuf.
async function fresh() {
  vi.resetModules();
  return (await import("@/lib/frameFit")).frameFitPreference;
}

describe("frameFitPreference", () => {
  it("ajuste par défaut", async () => {
    expect((await fresh()).snapshot()).toBe(true);
  });

  // Par appareil : coupé une fois, coupé pour les films suivants.
  it("retient qu'on l'a coupé, et le dit à qui écoute", async () => {
    const store = await fresh();
    let told = 0;
    store.subscribe(() => (told += 1));
    store.set(false);
    expect(store.snapshot()).toBe(false);
    expect(told).toBe(1);
    expect((await fresh()).snapshot()).toBe(false);
  });

  it("ajuste quand le stockage est illisible", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqué");
    });
    expect((await fresh()).snapshot()).toBe(true);
    vi.restoreAllMocks();
  });
});
