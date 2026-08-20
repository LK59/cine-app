import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const MEDIA_ROOT  = "/mnt/media/video";
const MOVIES_PATH = `${MEDIA_ROOT}/movies`;
const TV_PATH     = `${MEDIA_ROOT}/tv`;
const SEEDS_PATH  = `${MEDIA_ROOT}/downloads/seeds`;

export interface DiskStats {
  moviesBytes: number;
  tvBytes: number;
  /** Seed-side bytes NOT sharing an inode with a library file — i.e. actually occupying
   *  separate disk space (still-downloading torrents, cross-seed links not yet merged,
   *  orphans). Seeds already hardlinked into movies/tv cost no extra space and are
   *  excluded, since they're already counted in moviesBytes/tvBytes. */
  seedsBytes: number;
  disk: { total: number; used: number; free: number };
  computedAt: number;
  computing: boolean;
  error: string | null;
}

// ─── Internal state ───────────────────────────────────────────────────────────

let cached: DiskStats | null = null;
let computing = false;
const CACHE_TTL_MS = 10 * 60_000;

/** Maps "dev:ino" -> size for every regular file under `path`, deduping hardlinks
 *  (same inode counted once). Uses `find -exec stat` rather than walking in Node — a
 *  single native process handles thousands of files far faster than per-file fs.stat
 *  calls, and it still gives us the per-file inode `du` can't. Deliberately not
 *  `find -printf`: the container runs BusyBox find, which doesn't support it and
 *  fails the whole command silently (swallowed by `|| true`) rather than falling
 *  back — GNU find's -printf is a no-op-looking trap here. */
async function findInodeSizesAsync(path: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { stdout } = await execAsync(
      `find "${path}" -type f -exec stat -c '%d:%i %s' {} + 2>/dev/null || true`,
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
    );
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) continue;
      const key = line.slice(0, spaceIdx);
      const size = parseInt(line.slice(spaceIdx + 1));
      if (!isNaN(size) && !map.has(key)) map.set(key, size);
    }
  } catch { /* leave map empty — treated as "unknown", not zero, by caller error state */ }
  return map;
}

function sumSizes(map: Map<string, number>): number {
  let total = 0;
  for (const size of map.values()) total += size;
  return total;
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
    const [movieInodes, tvInodes, seedInodes, disk] = await Promise.all([
      findInodeSizesAsync(MOVIES_PATH),
      findInodeSizesAsync(TV_PATH),
      findInodeSizesAsync(SEEDS_PATH),
      dfStatsAsync(MEDIA_ROOT),
    ]);

    const moviesBytes = sumSizes(movieInodes);
    const tvBytes = sumSizes(tvInodes);

    // Seeds already hardlinked into movies/ or tv/ occupy no extra disk space — only
    // count seed-side bytes whose inode isn't already part of the library.
    let seedsBytes = 0;
    for (const [key, size] of seedInodes) {
      if (!movieInodes.has(key) && !tvInodes.has(key)) seedsBytes += size;
    }

    cached = { moviesBytes, tvBytes, seedsBytes, disk, computedAt: Date.now(), computing: false, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cached = cached
      ? { ...cached, computing: false, error: msg }
      : { moviesBytes: -1, tvBytes: -1, seedsBytes: -1, disk: { total: -1, used: -1, free: -1 }, computedAt: Date.now(), computing: false, error: msg };
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
  return { moviesBytes: -1, tvBytes: -1, seedsBytes: -1, disk: { total: -1, used: -1, free: -1 }, computedAt: 0, computing: true, error: null };
}

// Warm up on module load
triggerCompute();
