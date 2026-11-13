import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { MEDIA_ROOT, MOVIES_PATH, TV_PATH, SEEDS_PATH } from "@/lib/media-paths";
import { dfStatsAsync, parseDfLine, UNKNOWN_DISK } from "@/lib/diskUsage";

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

/**
 * L'état vit sur `globalThis` (13/11/2026), comme le cache du serveur : la préparation au démarrage
 * (`statsPrewarm.ts`, lancée par `instrumentation.ts`) et les routes sont compilées en points d'entrée
 * séparés, chacun avec sa copie de ce module — une mesure préparée dans l'une n'aurait jamais été lue
 * par l'autre.
 */
interface DiskState { cached: DiskStats | null; computing: boolean }
function state(): DiskState {
  const g = globalThis as unknown as Record<symbol, DiskState | undefined>;
  return (g[Symbol.for("laterna.diskStats")] ??= { cached: null, computing: false });
}
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

// `df` et sa lecture vivent dans `diskUsage.ts` (13/11/2026) : le relevé quotidien de l'occupation
// (`diskSamples.ts`) en a besoin sans importer ce module, dont le chargement lance l'inventaire entier.
export { parseDfLine };

/** Le dossier des médias existe-t-il dans le conteneur ? Sans lui, il n'y a rien à mesurer. */
async function mediaRootPresent(): Promise<boolean> {
  try {
    return (await fs.stat(MEDIA_ROOT)).isDirectory();
  } catch {
    return false;
  }
}

async function computeAsync(): Promise<void> {
  const st = state();
  try {
    if (!(await mediaRootPresent())) {
      st.cached = { moviesBytes: 0, tvBytes: 0, seedsBytes: 0, disk: UNKNOWN_DISK, computedAt: Date.now(), computing: false, error: null, mediaMissing: true };
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

    st.cached = { moviesBytes, tvBytes, seedsBytes, disk, computedAt: Date.now(), computing: false, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    st.cached = st.cached
      ? { ...st.cached, computing: false, error: msg }
      : { moviesBytes: -1, tvBytes: -1, seedsBytes: -1, disk: { total: -1, used: -1, free: -1 }, computedAt: Date.now(), computing: false, error: msg };
  } finally {
    st.computing = false;
  }
}

function triggerCompute(): void {
  const st = state();
  if (st.computing) return;
  st.computing = true;
  computeAsync(); // fire-and-forget — truly non-blocking
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getDiskStats(forceRefresh = false): DiskStats {
  const st = state();
  const expired = !st.cached || Date.now() - st.cached.computedAt > CACHE_TTL_MS;
  if (forceRefresh || expired) triggerCompute();
  if (st.cached) return { ...st.cached, computing: st.computing };
  return { moviesBytes: -1, tvBytes: -1, seedsBytes: -1, disk: { total: -1, used: -1, free: -1 }, computedAt: 0, computing: true, error: null };
}

// Warm up on module load
triggerCompute();
