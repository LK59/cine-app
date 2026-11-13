import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * La page Statistiques après un démarrage (13/11/2026). Ses calculs lourds répondent vide tant
 * qu'ils tournent en arrière-plan ; la prévision de saturation le lisait « historique insuffisant —
 * revient dans quelques jours », et la page ne repassait que deux minutes plus tard. Relevé dans le
 * journal du proxy : stockage 290 octets, acteurs 66 octets, prévision 109 octets à l'ouverture.
 */

const storage = vi.hoisted(() => ({ value: {} as { computedAt: number; monthlyGrowth: { month: string; bytes: number }[] } }));
const disk = vi.hoisted(() => ({ value: {} as { computedAt: number; disk: { total: number; used: number; free: number } } }));

vi.mock("@/lib/storage-scan", () => ({ getStorageStats: () => storage.value }));
vi.mock("@/lib/disk-stats", () => ({ getDiskStats: () => disk.value }));

import { computeDiskForecast } from "@/lib/diskForecast";
import { statsRefreshInterval, STATS_PENDING_POLL_MS } from "@/lib/statsPolling";
import { INTERVALS } from "@/lib/refresh-intervals";

const TB = 1e12;
const GROWTH = [
  { month: "2026-08", bytes: 2 * TB },
  { month: "2026-09", bytes: 1 * TB },
  { month: "2026-10", bytes: 3 * TB },
  { month: "2026-11", bytes: 0.5 * TB },
];

beforeEach(() => {
  storage.value = { computedAt: 1, monthlyGrowth: GROWTH };
  disk.value = { computedAt: 1, disk: { total: 30 * TB, used: 18 * TB, free: 12 * TB } };
});

describe("prévision de saturation avant la première analyse", () => {
  it("dit « en cours » tant que l'analyse du stockage n'a rien rendu", () => {
    storage.value = { computedAt: 0, monthlyGrowth: [] };
    const f = computeDiskForecast();
    expect(f.pending).toBe(true);
    expect(f.daysUntilFull).toBeNull();
  });

  it("dit « en cours » tant que le disque n'est pas mesuré", () => {
    disk.value = { computedAt: 0, disk: { total: -1, used: -1, free: -1 } };
    expect(computeDiskForecast().pending).toBe(true);
  });

  it("rend la date une fois les deux prêts — chiffres de la bibliothèque du 13/11/2026", () => {
    const f = computeDiskForecast();
    expect(f.pending).toBe(false);
    expect(f.trend).toBe("growing");
    // 2 To par mois en moyenne sur août-octobre, 12 To libres : ~183 jours.
    expect(f.daysUntilFull).toBe(Math.round(12 * TB / (2 * TB / 30.44)));
  });
});

describe("statsRefreshInterval", () => {
  it("revient vite tant que le serveur calcule, lentement ensuite", () => {
    expect(statsRefreshInterval({ computing: true })).toBe(STATS_PENDING_POLL_MS);
    expect(statsRefreshInterval({ pending: true })).toBe(STATS_PENDING_POLL_MS);
    expect(statsRefreshInterval({ computing: false })).toBe(INTERVALS.SLOW);
    expect(statsRefreshInterval(undefined)).toBe(INTERVALS.SLOW);
    expect(STATS_PENDING_POLL_MS).toBeLessThan(10_000);
  });
});
