import fs from "fs/promises";
import path from "path";

const MEDIA_ROOT = "/mnt/media/video";
const MOVIES_PATH = `${MEDIA_ROOT}/movies`;
const TV_PATH = `${MEDIA_ROOT}/tv`;
const SEED_MOVIES_PATH = `${MEDIA_ROOT}/downloads/seeds/movies`;
const SEED_TV_PATH = `${MEDIA_ROOT}/downloads/seeds/tv`;
const CROSS_SEED_PATH = `${MEDIA_ROOT}/downloads/seeds/cross-seed-links`;

const VIDEO_EXT = new Set([".mkv", ".mp4", ".avi", ".m4v", ".ts", ".wmv", ".mov"]);
const EPISODE_TAG_RE = /S(\d{1,2})E(\d{1,3})/i;

interface FileStat {
  name: string;
  size: number;
  dev: number;
  ino: number;
  nlink: number;
}

interface SeedFile extends FileStat {
  origin: "seed" | "cross-seed";
  tracker?: string;
}

interface LibraryItem {
  type: "movie" | "series";
  title: string;
  files: FileStat[];
}

export interface StorageStats {
  computedAt: number;
  computing: boolean;
  error: string | null;
  movieFiles: { total: number; hardlinked: number; totalBytes: number };
  seriesFiles: { total: number; hardlinked: number; totalBytes: number };
  notHardlinked: { type: "movie" | "series"; title: string; fileName: string; sizeBytes: number }[];
  duplicates: { type: "movie" | "series"; title: string; wastedBytes: number; files: { name: string; sizeBytes: number }[] }[];
  seedOnlyBytes: number;
  seedOnlyCount: number;
  crossSeeded: { type: "movie" | "series"; title: string; sizeBytes: number; trackers: string[] }[];
}

function episodeKey(filename: string): string | null {
  const m = filename.match(EPISODE_TAG_RE);
  return m ? `S${m[1].padStart(2, "0")}E${m[2].padStart(3, "0")}` : null;
}

async function walk(root: string, depth = 0, maxDepth = 8): Promise<FileStat[]> {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirResults = await Promise.all(
    entries.filter((e) => e.isDirectory()).map((e) => walk(path.join(root, e.name), depth + 1, maxDepth))
  );

  const fileEntries = entries.filter(
    (e) => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()) && !e.name.toLowerCase().includes("sample")
  );
  const fileResults = await Promise.all(
    fileEntries.map(async (e): Promise<FileStat | null> => {
      try {
        const st = await fs.stat(path.join(root, e.name));
        return { name: e.name, size: st.size, dev: st.dev, ino: st.ino, nlink: st.nlink };
      } catch {
        return null;
      }
    })
  );

  return [...dirResults.flat(), ...fileResults.filter((f): f is FileStat => f !== null)];
}

async function walkLibraryGrouped(root: string, type: "movie" | "series"): Promise<LibraryItem[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const items = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => ({ type, title: e.name, files: await walk(path.join(root, e.name)) }))
  );
  return items.filter((it) => it.files.length > 0);
}

async function walkSeeds(): Promise<SeedFile[]> {
  const [movies, tv] = await Promise.all([walk(SEED_MOVIES_PATH), walk(SEED_TV_PATH)]);
  const base: SeedFile[] = [...movies, ...tv].map((f) => ({ ...f, origin: "seed" }));

  let crossSeed: SeedFile[] = [];
  try {
    const trackers = await fs.readdir(CROSS_SEED_PATH, { withFileTypes: true });
    const perTracker = await Promise.all(
      trackers
        .filter((t) => t.isDirectory())
        .map(async (t) => {
          const files = await walk(path.join(CROSS_SEED_PATH, t.name));
          return files.map((f): SeedFile => ({ ...f, origin: "cross-seed", tracker: t.name }));
        })
    );
    crossSeed = perTracker.flat();
  } catch {
    // cross-seed-links absent or unreadable — degrade gracefully, base seed matching still works
  }

  return [...base, ...crossSeed];
}

async function computeStorageStats(): Promise<Omit<StorageStats, "computing">> {
  const [movieItems, seriesItems, seedFiles] = await Promise.all([
    walkLibraryGrouped(MOVIES_PATH, "movie"),
    walkLibraryGrouped(TV_PATH, "series"),
    walkSeeds(),
  ]);

  const seedIndex = new Map<string, SeedFile[]>();
  for (const f of seedFiles) {
    const key = `${f.dev}:${f.ino}`;
    const arr = seedIndex.get(key);
    if (arr) arr.push(f);
    else seedIndex.set(key, [f]);
  }

  const libraryInodes = new Set<string>();
  let moviesTotal = 0, moviesHardlinked = 0, moviesBytes = 0;
  let seriesTotal = 0, seriesHardlinked = 0, seriesBytes = 0;
  const notHardlinked: StorageStats["notHardlinked"] = [];
  const duplicates: StorageStats["duplicates"] = [];
  const crossSeededMap = new Map<string, { type: "movie" | "series"; title: string; sizeBytes: number; trackers: Set<string> }>();

  function processItem(item: LibraryItem) {
    for (const f of item.files) {
      libraryInodes.add(`${f.dev}:${f.ino}`);
      if (item.type === "movie") {
        moviesTotal++; moviesBytes += f.size;
        if (f.nlink > 1) moviesHardlinked++;
      } else {
        seriesTotal++; seriesBytes += f.size;
        if (f.nlink > 1) seriesHardlinked++;
      }

      if (f.nlink <= 1) {
        notHardlinked.push({ type: item.type, title: item.title, fileName: f.name, sizeBytes: f.size });
      } else {
        const matches = seedIndex.get(`${f.dev}:${f.ino}`) ?? [];
        const trackers = new Set(matches.filter((m) => m.origin === "cross-seed").map((m) => m.tracker!));
        if (trackers.size > 0) {
          crossSeededMap.set(`${item.type}:${item.title}:${f.name}`, { type: item.type, title: item.title, sizeBytes: f.size, trackers });
        }
      }
    }

    if (item.type === "movie") {
      if (item.files.length > 1) {
        const sorted = [...item.files].sort((a, b) => b.size - a.size);
        const wasted = sorted.slice(1).reduce((s, f) => s + f.size, 0);
        duplicates.push({ type: "movie", title: item.title, wastedBytes: wasted, files: sorted.map((f) => ({ name: f.name, sizeBytes: f.size })) });
      }
    } else {
      const bySlot = new Map<string, FileStat[]>();
      for (const f of item.files) {
        const key = episodeKey(f.name);
        if (!key) continue;
        const arr = bySlot.get(key);
        if (arr) arr.push(f);
        else bySlot.set(key, [f]);
      }
      for (const [key, group] of bySlot) {
        if (group.length > 1) {
          const sorted = [...group].sort((a, b) => b.size - a.size);
          const wasted = sorted.slice(1).reduce((s, f) => s + f.size, 0);
          duplicates.push({ type: "series", title: `${item.title} · ${key}`, wastedBytes: wasted, files: sorted.map((f) => ({ name: f.name, sizeBytes: f.size })) });
        }
      }
    }
  }

  for (const it of movieItems) processItem(it);
  for (const it of seriesItems) processItem(it);

  let seedOnlyBytes = 0, seedOnlyCount = 0;
  const seenSeedInode = new Set<string>();
  for (const f of seedFiles) {
    const key = `${f.dev}:${f.ino}`;
    if (libraryInodes.has(key) || seenSeedInode.has(key)) continue;
    seenSeedInode.add(key);
    seedOnlyBytes += f.size;
    seedOnlyCount++;
  }

  notHardlinked.sort((a, b) => b.sizeBytes - a.sizeBytes);
  duplicates.sort((a, b) => b.wastedBytes - a.wastedBytes);
  const crossSeeded = [...crossSeededMap.values()]
    .map((c) => ({ type: c.type, title: c.title, sizeBytes: c.sizeBytes, trackers: [...c.trackers] }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    computedAt: Date.now(),
    error: null,
    movieFiles: { total: moviesTotal, hardlinked: moviesHardlinked, totalBytes: moviesBytes },
    seriesFiles: { total: seriesTotal, hardlinked: seriesHardlinked, totalBytes: seriesBytes },
    notHardlinked: notHardlinked.slice(0, 30),
    duplicates: duplicates.slice(0, 30),
    seedOnlyBytes,
    seedOnlyCount,
    crossSeeded: crossSeeded.slice(0, 30),
  };
}

// ─── Internal state (fire-and-forget cache, mirrors disk-stats.ts) ────────────

const EMPTY: Omit<StorageStats, "computing" | "computedAt" | "error"> = {
  movieFiles: { total: 0, hardlinked: 0, totalBytes: 0 },
  seriesFiles: { total: 0, hardlinked: 0, totalBytes: 0 },
  notHardlinked: [],
  duplicates: [],
  seedOnlyBytes: 0,
  seedOnlyCount: 0,
  crossSeeded: [],
};

let cached: Omit<StorageStats, "computing"> | null = null;
let computing = false;
const CACHE_TTL_MS = 30 * 60_000;

async function computeAsync(): Promise<void> {
  try {
    cached = await computeStorageStats();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cached = cached ? { ...cached, error: msg } : { computedAt: Date.now(), error: msg, ...EMPTY };
  } finally {
    computing = false;
  }
}

function triggerCompute(): void {
  if (computing) return;
  computing = true;
  computeAsync();
}

export function getStorageStats(forceRefresh = false): StorageStats {
  const expired = !cached || Date.now() - cached.computedAt > CACHE_TTL_MS;
  if (forceRefresh || expired) triggerCompute();
  if (cached) return { ...cached, computing };
  return { computedAt: 0, computing: true, error: null, ...EMPTY };
}

// Warm up on module load
triggerCompute();
