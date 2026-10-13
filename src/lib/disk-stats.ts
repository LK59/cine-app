import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { MEDIA_ROOT, MOVIES_PATH, TV_PATH, SEEDS_PATH } from "@/lib/media-paths";

const execAsync = promisify(exec);

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
  /**
   * Le dossier des médias (`MEDIA_ROOT`) n'existe pas dans le conteneur : il n'est pas monté. La
   * carte Stockage le dit, au lieu de chiffres vides (13/10/2026).
   */
  mediaMissing?: boolean;
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
    return parseDfLine(stdout);
  } catch { return { total: -1, used: -1, free: -1 }; }
}

const UNKNOWN_DISK = { total: -1, used: -1, free: -1 };

/**
 * La dernière ligne de `df -B1 -P`. Sur un chemin absent, `df` n'écrit que son en-tête, et
 * `tail -1` le rendait : « 1-blocks » se lisait 1 octet, « Used » et « Available » NaN — la carte
 * Stockage d'une installation sans dossier de médias affichait « — libres sur 1.0 B » (13/10/2026).
 * Tout ce qui n'est pas trois nombres est « inconnu ».
 */
export function parseDfLine(stdout: string): { total: number; used: number; free: number } {
  const parts = stdout.trim().split(/\s+/);
  const [total, used, free] = [parts[1], parts[2], parts[3]].map((p) => (p !== undefined && /^\d+$/.test(p) ? Number(p) : NaN));
  if (!Number.isFinite(total) || !Number.isFinite(used) || !Number.isFinite(free) || total <= 0) return UNKNOWN_DISK;
  return { total, used, free };
}

/** Le dossier des médias existe-t-il dans le conteneur ? Sans lui, il n'y a rien à mesurer. */
async function mediaRootPresent(): Promise<boolean> {
  try {
    return (await fs.stat(MEDIA_ROOT)).isDirectory();
  } catch {
    return false;
  }
}

async function computeAsync(): Promise<void> {
  try {
    if (!(await mediaRootPresent())) {
      cached = { moviesBytes: 0, tvBytes: 0, seedsBytes: 0, disk: UNKNOWN_DISK, computedAt: Date.now(), computing: false, error: null, mediaMissing: true };
      return;
    }
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
