import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const MEDIA_ROOT  = "/mnt/media/video";
const MOVIES_PATH = `${MEDIA_ROOT}/movies`;
const TV_PATH     = `${MEDIA_ROOT}/tv`;

export interface DiskStats {
  moviesBytes: number;
  tvBytes: number;
  disk: { total: number; used: number; free: number };
  computedAt: number;
  computing: boolean;
  error: string | null;
}

// ─── Internal state ───────────────────────────────────────────────────────────

let cached: DiskStats | null = null;
let computing = false;
const CACHE_TTL_MS = 10 * 60_000;

async function duBytesAsync(path: string): Promise<number> {
  try {
    const { stdout } = await execAsync(`du -sb "${path}" 2>/dev/null || true`, { timeout: 30_000 });
    const val = parseInt(stdout.split("\t")[0]);
    return isNaN(val) ? -1 : val;
  } catch { return -1; }
}

async function dfStatsAsync(path: string): Promise<{ total: number; used: number; free: number }> {
  try {
    // -P (POSIX format) forces single-line output regardless of filesystem name length.
    // Without it, `df` wraps onto a second line once the filesystem name is long enough
    // (e.g. a ZFS dataset or LVM name) — `tail -1` would then grab a line that happens to
    // start with the numeric columns instead of the filesystem name, shifting every field
    // by one. That only "worked" here by accident, for however long the mount's name stayed
    // long enough to trigger the wrap.
    const { stdout } = await execAsync(`df -B1 -P "${path}" 2>/dev/null | tail -1`, { timeout: 5_000 });
    const parts = stdout.trim().split(/\s+/);
    return { total: parseInt(parts[1]), used: parseInt(parts[2]), free: parseInt(parts[3]) };
  } catch { return { total: -1, used: -1, free: -1 }; }
}

async function computeAsync(): Promise<void> {
  try {
    const [moviesBytes, tvBytes, disk] = await Promise.all([
      duBytesAsync(MOVIES_PATH),
      duBytesAsync(TV_PATH),
      dfStatsAsync(MEDIA_ROOT),
    ]);
    cached = { moviesBytes, tvBytes, disk, computedAt: Date.now(), computing: false, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cached = cached
      ? { ...cached, computing: false, error: msg }
      : { moviesBytes: -1, tvBytes: -1, disk: { total: -1, used: -1, free: -1 }, computedAt: Date.now(), computing: false, error: msg };
  } finally {
    computing = false;
  }
}

function triggerCompute(): void {
  if (computing) return;
  computing = true;
  computeAsync(); // fire-and-forget — truly non-blocking
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getDiskStats(forceRefresh = false): DiskStats {
  const expired = !cached || Date.now() - cached.computedAt > CACHE_TTL_MS;
  if (forceRefresh || expired) triggerCompute();
  if (cached) return { ...cached, computing };
  return { moviesBytes: -1, tvBytes: -1, disk: { total: -1, used: -1, free: -1 }, computedAt: 0, computing: true, error: null };
}

// Warm up on module load
triggerCompute();
