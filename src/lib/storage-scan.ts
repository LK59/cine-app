import fs from "fs/promises";
import path from "path";
import { cachedMovies } from "@/lib/server-cache";

const MEDIA_ROOT = "/mnt/media/video";
const MOVIES_PATH = `${MEDIA_ROOT}/movies`;
const TV_PATH = `${MEDIA_ROOT}/tv`;
const SEED_MOVIES_PATH = `${MEDIA_ROOT}/downloads/seeds/movies`;
const SEED_TV_PATH = `${MEDIA_ROOT}/downloads/seeds/tv`;
const CROSS_SEED_PATH = `${MEDIA_ROOT}/downloads/seeds/cross-seed-links`;

const VIDEO_EXT = new Set([".mkv", ".mp4", ".avi", ".m4v", ".ts", ".wmv", ".mov"]);
const EPISODE_TAG_RE = /^(.*?)[.\s_-]*S(\d{1,2})E(\d{1,3})\b/i;
const YEAR_RE = /^(.*?)[[(.\s](\d{4})[\])]?/;
// Codec is read from the release filename, not mediainfo/ffprobe — probing every
// file would mean spawning a process per video and made the scan too slow to be usable.
const H264_RE = /\b(x264|h\.?264|avc1?)\b/i;

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
  /** Library files with no seed copy — informational, NOT anomalous (a movie can legitimately have no active seed). */
  notHardlinked: { type: "movie" | "series"; title: string; fileName: string; sizeBytes: number }[];
  /** Seed-side files with no matching library file — genuinely wasted space, worth reviewing. */
  seedOrphans: { title: string; fileName: string; sizeBytes: number; trackers: string[] }[];
  seedOrphanBytes: number;
  crossSeedByTracker: {
    tracker: string;
    totalBytes: number;
    files: { title: string; fileName: string; sizeBytes: number; linkedToLibrary: boolean }[];
  }[];
  /** Same title/episode found as more than one distinct file (different release/codec/resolution). */
  duplicates: {
    type: "movie" | "series";
    title: string;
    wastedBytes: number;
    releases: { name: string; sizeBytes: number; inLibrary: boolean }[];
  }[];
  heaviestH264: { type: "movie" | "series"; title: string; sizeBytes: number }[];
}

function normalizeReleaseTitle(raw: string): string {
  return raw.toLowerCase().replace(/[._]/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Parses a stable grouping key out of an arbitrary release/library filename, so the
 *  same movie or episode can be recognized across differently-named releases
 *  (e.g. "Film.2019.HEVC.mkv" vs "Film (2019) 1080p x264.mkv"). */
function parseReleaseKey(name: string): { key: string; kind: "movie" | "series" } | null {
  const epMatch = name.match(EPISODE_TAG_RE);
  if (epMatch) {
    const show = normalizeReleaseTitle(epMatch[1]);
    if (!show) return null;
    const tag = `S${epMatch[2].padStart(2, "0")}E${epMatch[3].padStart(3, "0")}`;
    return { key: `ep:${show}:${tag}`, kind: "series" };
  }
  const movieMatch = name.match(YEAR_RE);
  if (movieMatch) {
    const year = parseInt(movieMatch[2]);
    if (year < 1900 || year > 2099) return null;
    const title = normalizeReleaseTitle(movieMatch[1]);
    if (!title) return null;
    return { key: `mv:${title}:${year}`, kind: "movie" };
  }
  return null;
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

function displayTitle(name: string): string {
  const parsed = parseReleaseKey(name);
  if (!parsed) return name;
  if (parsed.kind === "movie") {
    const m = name.match(YEAR_RE);
    return m ? `${m[1].replace(/[._]/g, " ").trim()} (${m[2]})` : name;
  }
  const m = name.match(EPISODE_TAG_RE);
  return m ? `${m[1].replace(/[._]/g, " ").trim()} · S${m[2].padStart(2, "0")}E${m[3].padStart(3, "0")}` : name;
}

async function computeStorageStats(): Promise<Omit<StorageStats, "computing">> {
  // Movie codec comes from Radarr's own mediaInfo (already fetched/cached elsewhere in
  // the app, one bulk call) — more reliable than filename sniffing, since Radarr often
  // renames files to "Title (Year).mkv" with no codec tag left in the name at all.
  // Series use the filename heuristic below: probing every episode's mediainfo, or
  // calling Sonarr per-series, made the scan too slow to be usable.
  const [movieItems, seriesItems, seedFiles, radarrMovies] = await Promise.all([
    walkLibraryGrouped(MOVIES_PATH, "movie"),
    walkLibraryGrouped(TV_PATH, "series"),
    walkSeeds(),
    cachedMovies().catch(() => []),
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

  // dev:ino -> release candidate, for duplicate detection across library + seed pool
  const releaseSeen = new Set<string>();
  const releaseGroups = new Map<string, { kind: "movie" | "series"; releases: { name: string; sizeBytes: number; inLibrary: boolean }[] }>();

  function addReleaseCandidate(name: string, dev: number, ino: number, size: number, inLibrary: boolean, fallbackKey?: string) {
    const invKey = `${dev}:${ino}`;
    if (releaseSeen.has(invKey)) return;
    releaseSeen.add(invKey);
    const parsed = parseReleaseKey(name) ?? (fallbackKey ? parseReleaseKey(fallbackKey) : null);
    if (!parsed) return;
    let group = releaseGroups.get(parsed.key);
    if (!group) {
      group = { kind: parsed.kind, releases: [] };
      releaseGroups.set(parsed.key, group);
    }
    group.releases.push({ name, sizeBytes: size, inLibrary });
  }

  const heaviestH264: StorageStats["heaviestH264"] = [];
  for (const m of radarrMovies) {
    const mf = m.movieFile;
    const codec = (mf?.mediaInfo?.videoCodec ?? "").toLowerCase();
    if (codec.includes("264") && mf?.size) {
      heaviestH264.push({ type: "movie", title: `${m.title} (${m.year})`, sizeBytes: mf.size });
    }
  }

  for (const item of movieItems) {
    for (const f of item.files) {
      libraryInodes.add(`${f.dev}:${f.ino}`);
      moviesTotal++; moviesBytes += f.size;
      if (f.nlink > 1) moviesHardlinked++;
      else notHardlinked.push({ type: "movie", title: item.title, fileName: f.name, sizeBytes: f.size });
      addReleaseCandidate(f.name, f.dev, f.ino, f.size, true, item.title);
    }
  }
  for (const item of seriesItems) {
    let h264Bytes = 0;
    for (const f of item.files) {
      libraryInodes.add(`${f.dev}:${f.ino}`);
      seriesTotal++; seriesBytes += f.size;
      if (f.nlink > 1) seriesHardlinked++;
      else notHardlinked.push({ type: "series", title: item.title, fileName: f.name, sizeBytes: f.size });
      addReleaseCandidate(f.name, f.dev, f.ino, f.size, true);
      if (H264_RE.test(f.name)) h264Bytes += f.size;
    }
    if (h264Bytes > 0) heaviestH264.push({ type: "series", title: item.title, sizeBytes: h264Bytes });
  }
  heaviestH264.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const heaviestH264Top = heaviestH264.slice(0, 50);
  for (const f of seedFiles) {
    addReleaseCandidate(f.name, f.dev, f.ino, f.size, false);
  }

  // Seed orphans: distinct seed-side files (by inode) with no library match at all
  const seedOrphanMap = new Map<string, { title: string; fileName: string; sizeBytes: number; trackers: Set<string> }>();
  for (const f of seedFiles) {
    const key = `${f.dev}:${f.ino}`;
    if (libraryInodes.has(key)) continue;
    let entry = seedOrphanMap.get(key);
    if (!entry) {
      entry = { title: displayTitle(f.name), fileName: f.name, sizeBytes: f.size, trackers: new Set() };
      seedOrphanMap.set(key, entry);
    }
    if (f.origin === "cross-seed" && f.tracker) entry.trackers.add(f.tracker);
  }
  const seedOrphans = [...seedOrphanMap.values()]
    .map((o) => ({ title: o.title, fileName: o.fileName, sizeBytes: o.sizeBytes, trackers: [...o.trackers] }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const seedOrphanBytes = seedOrphans.reduce((s, o) => s + o.sizeBytes, 0);

  // Cross-seed grouped by tracker
  const trackerMap = new Map<string, { totalBytes: number; files: { title: string; fileName: string; sizeBytes: number; linkedToLibrary: boolean }[] }>();
  for (const f of seedFiles) {
    if (f.origin !== "cross-seed" || !f.tracker) continue;
    let group = trackerMap.get(f.tracker);
    if (!group) {
      group = { totalBytes: 0, files: [] };
      trackerMap.set(f.tracker, group);
    }
    group.totalBytes += f.size;
    group.files.push({ title: displayTitle(f.name), fileName: f.name, sizeBytes: f.size, linkedToLibrary: libraryInodes.has(`${f.dev}:${f.ino}`) });
  }
  const crossSeedByTracker = [...trackerMap.entries()]
    .map(([tracker, g]) => ({ tracker, totalBytes: g.totalBytes, files: g.files.sort((a, b) => b.sizeBytes - a.sizeBytes) }))
    .sort((a, b) => b.totalBytes - a.totalBytes);

  // Duplicates: groups with more than one distinct physical file for the same title/episode
  const duplicates: StorageStats["duplicates"] = [];
  for (const [key, group] of releaseGroups) {
    if (group.releases.length < 2) continue;
    const sorted = [...group.releases].sort((a, b) => b.sizeBytes - a.sizeBytes);
    const wastedBytes = sorted.slice(1).reduce((s, r) => s + r.sizeBytes, 0);
    const title = displayTitle(sorted[0].name) || key;
    duplicates.push({ type: group.kind, title, wastedBytes, releases: sorted });
  }
  duplicates.sort((a, b) => b.wastedBytes - a.wastedBytes);

  notHardlinked.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    computedAt: Date.now(),
    error: null,
    movieFiles: { total: moviesTotal, hardlinked: moviesHardlinked, totalBytes: moviesBytes },
    seriesFiles: { total: seriesTotal, hardlinked: seriesHardlinked, totalBytes: seriesBytes },
    notHardlinked,
    seedOrphans,
    seedOrphanBytes,
    crossSeedByTracker,
    duplicates,
    heaviestH264: heaviestH264Top,
  };
}

// ─── Internal state (fire-and-forget cache, mirrors disk-stats.ts) ────────────

const EMPTY: Omit<StorageStats, "computing" | "computedAt" | "error"> = {
  movieFiles: { total: 0, hardlinked: 0, totalBytes: 0 },
  seriesFiles: { total: 0, hardlinked: 0, totalBytes: 0 },
  notHardlinked: [],
  seedOrphans: [],
  seedOrphanBytes: 0,
  crossSeedByTracker: [],
  duplicates: [],
  heaviestH264: [],
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
