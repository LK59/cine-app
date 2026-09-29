import { describe, it, expect, vi, beforeEach } from "vitest";

// A24 : la moyenne de croissance retirait les mois sans ajout (« 900 Go, 0, 0 » lu comme
// 900 Go/mois au lieu de 300), alors que storage-scan fournit exprès une série continue.
const monthlyGrowth = vi.hoisted(() => ({ value: [] as { month: string; bytes: number }[] }));

vi.mock("@/lib/storage-scan", () => ({
  getStorageStats: () => ({ monthlyGrowth: monthlyGrowth.value }),
}));
vi.mock("@/lib/disk-stats", () => ({
  getDiskStats: () => ({ disk: { total: 16e12, free: 4e12 } }),
}));

import { computeDiskForecast } from "@/lib/diskForecast";

const GB = 1e9;

describe("computeDiskForecast — mois vides", () => {
  beforeEach(() => { monthlyGrowth.value = []; });

  it("compte un mois sans ajout pour zéro dans la moyenne", () => {
    monthlyGrowth.value = [
      { month: "2026-06", bytes: 900 * GB },
      { month: "2026-07", bytes: 0 },
      { month: "2026-08", bytes: 0 },
      { month: "2026-09", bytes: 5 * GB }, // mois en cours, écarté
    ];
    const f = computeDiskForecast();
    expect(f.monthsUsed).toBe(3);
    expect(f.trend).toBe("growing");
    expect(f.growthBytesPerDay! * 30.44).toBeCloseTo(300 * GB, -3);
  });

  it("reste « insuffisant » quand les trois mois sont vides", () => {
    monthlyGrowth.value = [
      { month: "2026-06", bytes: 0 },
      { month: "2026-07", bytes: 0 },
      { month: "2026-08", bytes: 0 },
      { month: "2026-09", bytes: 5 * GB },
    ];
    expect(computeDiskForecast().trend).toBe("insufficient_data");
  });
});
