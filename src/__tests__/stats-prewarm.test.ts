import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * La page Statistiques préparée au démarrage (13/11/2026) : après les préchauffages du catalogue, l'un
 * après l'autre, et derrière `CINE_BACKGROUND_JOBS`.
 */

const order = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/disk-stats", () => ({ getDiskStats: () => { order.push("disque"); return {}; } }));
vi.mock("@/lib/storage-scan", () => ({
  warmStorageStats: async () => { order.push("stockage:début"); await new Promise((r) => setTimeout(r, 1_000)); order.push("stockage:fin"); },
}));
vi.mock("@/lib/peopleStats", () => ({ warmPeopleStats: async () => { order.push("personnes"); } }));
vi.mock("@/lib/taskLog", () => ({ taskLog: vi.fn() }));

import { startStatsPrewarm, __testing } from "@/lib/statsPrewarm";

const WARMED = Symbol.for("laterna.catalogueWarmedAt");

beforeEach(() => {
  vi.useFakeTimers();
  order.length = 0;
  __testing.reset();
});
afterEach(() => vi.useRealTimers());

describe("startStatsPrewarm", () => {
  it("attend les préchauffages du catalogue, puis enchaîne disque et analyse, et seulement ensuite les personnes", async () => {
    startStatsPrewarm();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(order).toEqual([]);
    (globalThis as unknown as Record<symbol, unknown>)[WARMED] = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(order).toEqual(["disque", "stockage:début"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["disque", "stockage:début", "stockage:fin", "personnes"]);
  });

  it("part quand même au bout de deux minutes si le catalogue ne finit jamais", async () => {
    startStatsPrewarm();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(order[0]).toBe("disque");
  });

  it("ne se lance qu'une fois", async () => {
    (globalThis as unknown as Record<symbol, unknown>)[WARMED] = Date.now();
    startStatsPrewarm();
    startStatsPrewarm();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(order.filter((o) => o === "disque")).toHaveLength(1);
  });
});

describe("instrumentation.ts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/instrumentation.ts"), "utf8");
  it("lance la préparation des statistiques et le relevé du disque derrière l'interrupteur", () => {
    expect(source).toMatch(/^\s*if \(jobs\) startStatsPrewarm\(\);$/m);
    expect(source).toMatch(/^\s*if \(jobs\) startDiskSampleCron\(\);$/m);
  });
});
