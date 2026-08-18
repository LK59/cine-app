import { getDiskStats } from "@/lib/disk-stats";
import { getStorageStats } from "@/lib/storage-scan";

// Below this, a slope is just measurement noise — showing a "347 days left" estimate off a
// couple of near-empty months would be more misleading than saying nothing.
const MIN_GROWTH_BYTES_PER_DAY = 50 * 1024 * 1024; // 50 MB/day
const AVG_DAYS_PER_MONTH = 30.44;
// How many recent complete months feed the average — long enough to smooth over one unusually
// quiet or heavy month, short enough to still reflect current habits rather than the library's
// entire history.
const MONTHS_FOR_AVERAGE = 3;

export type ForecastTrend = "growing" | "stable" | "insufficient_data";

export interface DiskForecast {
  trend: ForecastTrend;
  growthBytesPerDay: number | null;
  daysUntilFull: number | null;
  monthlyGrowth: { month: string; bytes: number }[];
  monthsUsed: number;
}

/** Derives a saturation forecast straight from what's already on disk — how many GB got added
 *  per month, from each library file's own mtime (see monthlyGrowth in storage-scan.ts) —
 *  instead of waiting weeks to accumulate a fresh sampling history. Available the moment the
 *  storage scan itself has run once. */
export function computeDiskForecast(): DiskForecast {
  const storage = getStorageStats();
  const disk = getDiskStats();
  const monthlyGrowth = storage.monthlyGrowth;

  // The current month is still in progress — including it would understate the real monthly
  // rate (e.g. "3 GB so far" on the 2nd of the month reads as a near-empty month).
  const nowMonth = monthlyGrowth[monthlyGrowth.length - 1]?.month;
  const completeMonths = nowMonth ? monthlyGrowth.filter((m) => m.month !== nowMonth) : monthlyGrowth;
  const recentMonths = completeMonths.slice(-MONTHS_FOR_AVERAGE).filter((m) => m.bytes > 0);

  if (recentMonths.length === 0 || disk.disk.total <= 0) {
    return { trend: "insufficient_data", growthBytesPerDay: null, daysUntilFull: null, monthlyGrowth, monthsUsed: recentMonths.length };
  }

  const avgBytesPerMonth = recentMonths.reduce((s, m) => s + m.bytes, 0) / recentMonths.length;
  const growthBytesPerDay = avgBytesPerMonth / AVG_DAYS_PER_MONTH;

  if (growthBytesPerDay < MIN_GROWTH_BYTES_PER_DAY) {
    return { trend: "stable", growthBytesPerDay, daysUntilFull: null, monthlyGrowth, monthsUsed: recentMonths.length };
  }

  const daysUntilFull = Math.round(disk.disk.free / growthBytesPerDay);
  return { trend: "growing", growthBytesPerDay, daysUntilFull, monthlyGrowth, monthsUsed: recentMonths.length };
}
