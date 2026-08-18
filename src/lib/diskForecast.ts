import { getDiskStats } from "@/lib/disk-stats";
import { diskUsageDb } from "@/lib/db";

const WINDOW_MS = 21 * 24 * 3600_000; // 3 weeks of history — recent enough to reflect current
                                        // habits, long enough to smooth out one heavy download day.
const MIN_SAMPLES = 3;
// Below this, a slope is just measurement noise — showing a "347 days left" estimate off three
// nearly-identical samples would be more misleading than saying nothing.
const MIN_GROWTH_BYTES_PER_DAY = 50 * 1024 * 1024; // 50 MB/day

export type ForecastTrend = "growing" | "stable" | "shrinking" | "insufficient_data";

export interface DiskForecast {
  trend: ForecastTrend;
  growthBytesPerDay: number | null;
  daysUntilFull: number | null;
  sampleCount: number;
  windowDays: number;
}

/** Takes a fresh disk-usage sample and stores it — call periodically (see statusCron.ts), not
 *  on every request; disk usage moves slowly enough that hourly is already generous. */
export function recordDiskUsageSample(): void {
  const stats = getDiskStats();
  if (stats.disk.total <= 0 || stats.disk.used < 0) return; // df failed — nothing usable to record
  diskUsageDb.record(stats.disk.used, stats.disk.total, Date.now());
}

/** Least-squares linear regression of used-bytes over time — robust to a single noisy sample in
 *  a way a naive "first vs last point" comparison wouldn't be. */
function linearRegressionSlope(points: { x: number; y: number }[]): number {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den; // bytes per ms
}

export function computeDiskForecast(): DiskForecast {
  const windowDays = WINDOW_MS / (24 * 3600_000);
  const history = diskUsageDb.getHistory(Date.now() - WINDOW_MS);

  if (history.length < MIN_SAMPLES) {
    return { trend: "insufficient_data", growthBytesPerDay: null, daysUntilFull: null, sampleCount: history.length, windowDays };
  }

  const slopePerMs = linearRegressionSlope(history.map((h) => ({ x: h.recordedAt, y: h.usedBytes })));
  const growthBytesPerDay = slopePerMs * 24 * 3600_000;
  const latest = history[history.length - 1];
  const freeBytes = latest.totalBytes - latest.usedBytes;

  if (Math.abs(growthBytesPerDay) < MIN_GROWTH_BYTES_PER_DAY) {
    return { trend: "stable", growthBytesPerDay, daysUntilFull: null, sampleCount: history.length, windowDays };
  }
  if (growthBytesPerDay < 0) {
    return { trend: "shrinking", growthBytesPerDay, daysUntilFull: null, sampleCount: history.length, windowDays };
  }

  const daysUntilFull = Math.round(freeBytes / growthBytesPerDay);
  return { trend: "growing", growthBytesPerDay, daysUntilFull, sampleCount: history.length, windowDays };
}
