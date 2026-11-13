import { describe, it, expect, vi, beforeEach } from "vitest";

// Sa propre base : ce fichier vide `disk_samples` à chaque test, et la base commune des tests est écrite
// par d'autres fichiers en même temps (voir `news-page-105.test.ts`).
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-disk-samples-"));
});

const storage = vi.hoisted(() => ({ value: {} as { computedAt: number; monthlyGrowth: { month: string; bytes: number }[] } }));
const disk = vi.hoisted(() => ({ value: {} as { computedAt: number; disk: { total: number; used: number; free: number } } }));
vi.mock("@/lib/storage-scan", () => ({ getStorageStats: () => storage.value }));
vi.mock("@/lib/disk-stats", () => ({ getDiskStats: () => disk.value }));

import { getDb } from "@/lib/db";
import {
  recordDiskSample, readDiskSamples, slopeFromSamples, sampleDiskOnce, localDay, hasDiskSampleFor,
  DISK_SAMPLES_KEPT_DAYS, MIN_SAMPLE_SPAN_DAYS, MIN_SAMPLE_COUNT, __testing, type DiskSample,
} from "@/lib/diskSamples";
import { computeDiskForecast } from "@/lib/diskForecast";

/**
 * La prévision de saturation par relevés quotidiens de l'occupation réelle (13/11/2026, DECISIONS.md
 * §153). Elle additionnait les imports de chaque mois, remplacements compris : octobre 2026 comptait
 * 4,36 To « ajoutés », et la date de saturation arrivait trop tôt.
 */

const TB = 1e12;
const GB = 1e9;
const DAY = 86_400_000;
const NOON = new Date(2026, 10, 13, 12, 0, 0).getTime();

function sample(daysAgo: number, used: number, total = 30 * TB): DiskSample {
  const at = NOON - daysAgo * DAY;
  return { day: localDay(at), usedBytes: used, freeBytes: total - used, totalBytes: total, sampledAt: at };
}

/** `n` relevés quotidiens finissant aujourd'hui, croissant de `perDay` octets par jour. */
function series(n: number, perDay: number, start = 18 * TB, noise = 0): DiskSample[] {
  return Array.from({ length: n }, (_, i) => sample(n - 1 - i, start + i * perDay + (i % 2 ? noise : -noise)));
}

beforeEach(() => {
  getDb().prepare("DELETE FROM disk_samples").run();
  __testing.reset();
  storage.value = { computedAt: 1, monthlyGrowth: [
    { month: "2026-08", bytes: 2 * TB }, { month: "2026-09", bytes: 1 * TB }, { month: "2026-10", bytes: 4.36 * TB }, { month: "2026-11", bytes: 0.2 * TB },
  ] };
  disk.value = { computedAt: 1, disk: { total: 30 * TB, used: 18 * TB, free: 12 * TB } };
});

describe("la table disk_samples", () => {
  it("existe après migrate(), et une seconde ouverture de la base ne la recrée ni ne la vide", async () => {
    recordDiskSample({ total: 30 * TB, used: 18 * TB, free: 12 * TB }, NOON);
    const cols = (getDb().prepare("PRAGMA table_info(disk_samples)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["day", "used_bytes", "free_bytes", "total_bytes", "sampled_at"]);
    vi.resetModules();
    const again = await import("@/lib/db");
    // Nouvelle copie du module : `migrate()` repasse sur le même fichier, sans erreur ni perte.
    expect((again.getDb().prepare("SELECT COUNT(*) AS n FROM disk_samples").get() as { n: number }).n).toBe(1);
  });
});

describe("un relevé par jour", () => {
  it("n'écrit qu'une ligne par jour, la première mesure du jour fait foi", () => {
    expect(recordDiskSample({ total: 30 * TB, used: 18 * TB, free: 12 * TB }, NOON)).toBe(true);
    expect(recordDiskSample({ total: 30 * TB, used: 19 * TB, free: 11 * TB }, NOON + 3600_000)).toBe(false);
    expect(recordDiskSample({ total: 30 * TB, used: 19 * TB, free: 11 * TB }, NOON + DAY)).toBe(true);
    const rows = readDiskSamples(30, NOON + DAY);
    expect(rows.map((r) => [r.day, r.usedBytes])).toEqual([[localDay(NOON), 18 * TB], [localDay(NOON + DAY), 19 * TB]]);
  });

  it("n'écrit rien d'une mesure inconnue (df muet, dossier des médias absent)", () => {
    expect(recordDiskSample({ total: -1, used: -1, free: -1 }, NOON)).toBe(false);
    expect(hasDiskSampleFor(NOON)).toBe(false);
  });

  it("borne la table à 400 jours", () => {
    recordDiskSample({ total: 30 * TB, used: 10 * TB, free: 20 * TB }, NOON - (DISK_SAMPLES_KEPT_DAYS + 5) * DAY);
    recordDiskSample({ total: 30 * TB, used: 11 * TB, free: 19 * TB }, NOON - 10 * DAY);
    recordDiskSample({ total: 30 * TB, used: 12 * TB, free: 18 * TB }, NOON);
    const days = (getDb().prepare("SELECT day FROM disk_samples ORDER BY day").all() as { day: string }[]).map((r) => r.day);
    expect(days).toEqual([localDay(NOON - 10 * DAY), localDay(NOON)]);
  });

  it("la tâche horaire ne mesure qu'une fois par jour : `df` n'est lancé qu'au premier passage", async () => {
    const measure = vi.fn(async () => ({ total: 30 * TB, used: 18 * TB, free: 12 * TB }));
    let now = NOON;
    expect(await sampleDiskOnce(() => now, measure)).toBe(true);
    for (let h = 1; h < 10; h++) {
      now = NOON + h * 3600_000;
      expect(await sampleDiskOnce(() => now, measure)).toBe(false);
    }
    expect(measure).toHaveBeenCalledTimes(1);
    // Après un redémarrage (mémoire vide), la base dit que le jour est relevé : toujours pas de `df`.
    __testing.reset();
    expect(await sampleDiskOnce(() => now, measure)).toBe(false);
    expect(measure).toHaveBeenCalledTimes(1);
    // Le lendemain, une mesure.
    now = NOON + DAY;
    expect(await sampleDiskOnce(() => now, measure)).toBe(true);
    expect(measure).toHaveBeenCalledTimes(2);
  });
});

describe("la pente des relevés", () => {
  it("attend quatorze jours et dix relevés", () => {
    expect(MIN_SAMPLE_SPAN_DAYS).toBe(14);
    expect(slopeFromSamples(series(14, 20 * GB))).toBeNull(); // 13 jours d'écart
    expect(slopeFromSamples(series(15, 20 * GB))).not.toBeNull();
    // Quinze jours d'écart, mais un serveur arrêté presque tout ce temps : pas de droite à deux points.
    const sparse = [sample(15, 18 * TB), ...series(MIN_SAMPLE_COUNT - 2, 20 * GB)];
    expect(slopeFromSamples(sparse)).toBeNull();
  });

  it("suit la tendance malgré le bruit d'un jour à l'autre", () => {
    const slope = slopeFromSamples(series(30, 20 * GB, 18 * TB, 150 * GB))!;
    expect(slope.bytesPerDay / GB).toBeGreaterThan(18);
    expect(slope.bytesPerDay / GB).toBeLessThan(22);
    expect(slope.spanDays).toBe(29);
  });

  it("ne garde que les relevés à la taille de disque actuelle", () => {
    // Un disque agrandi il y a 20 jours : avant, 16 To au total et une occupation sans rapport.
    const before = Array.from({ length: 30 }, (_, i) => sample(80 - i, 5 * TB + i * 100 * GB, 16 * TB));
    const after = series(20, 10 * GB);
    const slope = slopeFromSamples([...before, ...after])!;
    expect(slope.count).toBe(20);
    expect(slope.bytesPerDay / GB).toBeCloseTo(10, 5);
  });
});

describe("la prévision", () => {
  it("prend la pente réelle dès qu'il y a assez de relevés, et le dit", () => {
    const f = computeDiskForecast(series(30, 20 * GB));
    expect(f.method).toBe("samples");
    expect(f.trend).toBe("growing");
    expect(f.sampleDays).toBe(29);
    // 12 To libres à 20 Go par jour : 600 jours — et non les ~150 de la méthode par les imports.
    expect(f.daysUntilFull).toBe(600);
  });

  it("retombe sur les imports tant que les relevés sont trop courts, et dit où en sont les relevés", () => {
    const f = computeDiskForecast(series(5, 20 * GB));
    expect(f.method).toBe("imports");
    expect(f.sampleDays).toBe(4);
    expect(f.minSampleDays).toBe(14);
    // Août-octobre : (2 + 1 + 4,36) To / 3 mois.
    expect(f.daysUntilFull).toBe(Math.round(12 * TB / ((7.36 * TB / 3) / 30.44)));
  });

  it("lit la base quand on ne lui passe rien", () => {
    for (const s of series(20, 20 * GB)) recordDiskSample({ total: s.totalBytes, used: s.usedBytes, free: s.freeBytes }, s.sampledAt);
    vi.useFakeTimers({ now: NOON, toFake: ["Date"] });
    try {
      expect(computeDiskForecast().method).toBe("samples");
    } finally {
      vi.useRealTimers();
    }
  });

  it("un disque qui se vide est stable, pas une date dans le passé", () => {
    const f = computeDiskForecast(series(30, -30 * GB));
    expect(f.method).toBe("samples");
    expect(f.trend).toBe("stable");
    expect(f.daysUntilFull).toBeNull();
  });

  it("avec assez de relevés, n'attend pas l'analyse du stockage — seulement la mesure du disque", () => {
    storage.value = { computedAt: 0, monthlyGrowth: [] };
    expect(computeDiskForecast(series(30, 20 * GB)).pending).toBe(false);
    expect(computeDiskForecast(series(3, 20 * GB)).pending).toBe(true);
    disk.value = { computedAt: 0, disk: { total: -1, used: -1, free: -1 } };
    expect(computeDiskForecast(series(30, 20 * GB)).pending).toBe(true);
  });
});
