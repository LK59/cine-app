import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Le module importe les clients et la base : on ne teste ici que sa mécanique en mémoire.
vi.mock("@/lib/db", () => ({ kvCacheDb: { get: () => undefined, set: () => {} } }));
vi.mock("@/lib/clients/radarr", () => ({ radarr: {} }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: {} }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: {} }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: {} }));

import {
  withKeptCache,
  refreshKeptCache,
  startKeptCacheRefresh,
  stopKeptCacheRefresh,
  keptCacheKeys,
  invalidateKey,
} from "@/lib/server-cache";

const TTL = 120_000;

/** Une source qui rend « v1 », « v2 »… et compte ses appels. */
function source() {
  let n = 0;
  const fn = vi.fn(async () => `v${++n}`);
  return fn;
}

/** Laisse filer les promesses en attente (la relecture est lancée sans être attendue). */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("listes gardées chaudes (withKeptCache)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  });
  afterEach(() => {
    stopKeptCacheRefresh();
    vi.useRealTimers();
  });

  it("une lecture après le TTL n'attend pas la source : la relecture est passée avant", async () => {
    const fn = source();
    startKeptCacheRefresh();
    expect(await withKeptCache("k:a", TTL, fn)).toBe("v1");
    // Les trois quarts du TTL passés (et un tour du minuteur) : relu en arrière-plan.
    await vi.advanceTimersByTimeAsync(TTL * 0.75 + 5_000);
    expect(fn).toHaveBeenCalledTimes(2);
    // Bien après le TTL d'origine, la valeur est là, neuve, sans appel de plus à la lecture.
    await vi.advanceTimersByTimeAsync(TTL * 0.3);
    const calls = fn.mock.calls.length;
    const read = withKeptCache("k:a", TTL, fn);
    expect(fn.mock.calls.length).toBe(calls);
    expect(await read).toBe(`v${calls}`);
  });

  it("jamais plus vieille que son TTL : chaque valeur servie a moins de TTL d'âge", async () => {
    const fn = source();
    startKeptCacheRefresh();
    await withKeptCache("k:age", TTL, fn);
    const fetchedAt = new Map<string, number>([["v1", Date.now()]]);
    fn.mockImplementation(async () => {
      const v = `v${fn.mock.calls.length}`;
      fetchedAt.set(v, Date.now());
      return v;
    });
    for (let t = 0; t < 10 * TTL; t += 7_000) {
      await vi.advanceTimersByTimeAsync(7_000);
      const v = await withKeptCache("k:age", TTL, fn);
      expect(Date.now() - fetchedAt.get(v)!).toBeLessThan(TTL);
    }
  });

  it("sans minuteur démarré, rien ne part tout seul — le comportement de withCache", async () => {
    const fn = source();
    await withKeptCache("k:b", TTL, fn);
    await vi.advanceTimersByTimeAsync(TTL * 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await withKeptCache("k:b", TTL, fn)).toBe("v2");
  });

  it("une source qui échoue garde l'ancienne valeur et n'est pas harcelée", async () => {
    const fn = source();
    startKeptCacheRefresh();
    await withKeptCache("k:c", TTL, fn);
    fn.mockImplementation(async () => {
      throw new Error("Radarr absent");
    });
    await vi.advanceTimersByTimeAsync(TTL);
    // Une relecture aux trois quarts, puis une par quart de TTL au plus — pas une toutes les 5 s.
    expect(fn.mock.calls.length).toBeLessThanOrEqual(1 + 1 + Math.ceil(TTL / (TTL * 0.25)));
    expect(await withKeptCache("k:c", TTL, fn)).toBe("v1");
  });

  it("une invalidation relit tout de suite, et la lecture suivante a la valeur neuve", async () => {
    const fn = source();
    startKeptCacheRefresh();
    await withKeptCache("k:d", TTL, fn);
    invalidateKey("k:d");
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    const read = withKeptCache("k:d", TTL, fn);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await read).toBe("v2");
  });

  it("une liste que plus rien ne lit depuis un jour cesse d'être relue", async () => {
    const fn = source();
    startKeptCacheRefresh();
    await withKeptCache("k:e", TTL, fn);
    await vi.advanceTimersByTimeAsync(24 * 3600_000 + 10_000);
    expect(keptCacheKeys()).not.toContain("k:e");
    const calls = fn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TTL * 3);
    expect(fn.mock.calls.length).toBe(calls);
  });

  it("une relecture du minuteur ne compte pas comme une lecture", async () => {
    const fn = source();
    startKeptCacheRefresh();
    await withKeptCache("k:f", TTL, fn);
    refreshKeptCache(Date.now() + 25 * 3600_000);
    expect(keptCacheKeys()).not.toContain("k:f");
  });
});
