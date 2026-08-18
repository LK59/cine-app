import fs from "fs/promises";
import path from "path";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { bestTitleMatchScore } from "@/lib/search-natural-query";
import { qbittorrent } from "@/lib/clients/qbittorrent";

const MEDIA_ROOT = "/mnt/media/video";
const MOVIES_PATH = `${MEDIA_ROOT}/movies`;
const TV_PATH = `${MEDIA_ROOT}/tv`;
const SEED_MOVIES_PATH = `${MEDIA_ROOT}/downloads/seeds/movies`;
const SEED_TV_PATH = `${MEDIA_ROOT}/downloads/seeds/tv`;
const CROSS_SEED_PATH = `${MEDIA_ROOT}/downloads/seeds/cross-seed-links`;

const VIDEO_EXT = new Set([".mkv", ".mp4", ".avi", ".m4v", ".ts", ".wmv", ".mov"]);
const EPISODE_TAG_RE = /^(.*?)[.\s_-]*S(\d{1,2})E(\d{1,3})\b/i;
// Some scene releases (esp. Spanish/French) drop the "E" and separate season/episode with a dot,
// e.g. "LA.CASA.DE.PAPEL.S05.10.MULTI...mkv" — without this, those files never match the episode
// grouping key at all and can't be reconciled against the library or other seed copies.
const EPISODE_TAG_NO_E_RE = /^(.*?)[.\s_-]*S(\d{1,2})\.(\d{1,3})\b/i;
const YEAR_RE = /^(.*?)[[(.\s](\d{4})[\])]?/;
// Codec is read from the release filename, not mediainfo/ffprobe — probing every
// file would mean spawning a process per video and made the scan too slow to be usable.
const H264_RE = /\b(x264|h\.?264|avc1?)\b/i;

interface FileStat {
  name: string;
  /** Path relative to MEDIA_ROOT, e.g. "downloads/seeds/tv/Show/Season 01/Show.S01E05.mkv" — lets the UI point to the exact location on disk. */
  relPath: string;
  size: number;
  dev: number;
  ino: number;
  nlink: number;
  /** mtime survives hardlinking (both links share the same inode) — this is when the file was
   *  actually downloaded/completed, not when it was last linked into the library. Used to derive
   *  "how many GB got added per month" straight from what's already on disk, with no separate
   *  history to wait weeks for (see monthlyGrowth in StorageStats below). */
  mtimeMs: number;
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
  notHardlinked: { type: "movie" | "series"; title: string; fileName: string; relativePath: string; sizeBytes: number }[];
  /** Seed-side files with no matching library file — genuinely wasted space, worth reviewing.
   *  `inCatalog` tells apart a file whose title/episode is at least recognized in Radarr/Sonarr
   *  (e.g. an extra episode from a season pack that was never imported) from a true orphan that
   *  matches nothing in Radarr, Sonarr or the library at all. */
  /** `activeInQbittorrent` tells whether a matching torrent is still live in qBittorrent — if so
   *  the torrent should be removed there first (it'll re-appear otherwise); if false, qBittorrent
   *  has no record of it at all and the file is safe to delete directly from disk. */
  seedOrphans: { title: string; fileName: string; paths: string[]; sizeBytes: number; trackers: string[]; inCatalog: boolean; activeInQbittorrent: boolean }[];
  seedOrphanBytes: number;
  crossSeedByTracker: {
    tracker: string;
    totalBytes: number;
    files: { title: string; fileName: string; relativePath: string; sizeBytes: number; linkedToLibrary: boolean }[];
  }[];
  /** Same title/episode found as more than one distinct file (different release/codec/resolution). */
  duplicates: {
    type: "movie" | "series";
    title: string;
    wastedBytes: number;
    releases: { name: string; relativePath: string; sizeBytes: number; inLibrary: boolean }[];
  }[];
  heaviestH264: { type: "movie" | "series"; title: string; sizeBytes: number }[];
  /** Library file bytes bucketed by the month they were added (file mtime), oldest first,
   *  "YYYY-MM" keyed to match the app's other monthly charts. Covers the last 12 months. */
  monthlyGrowth: { month: string; bytes: number }[];
}

function normalizeReleaseTitle(raw: string): string {
  return raw.toLowerCase().replace(/[._]/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Parses a stable grouping key out of an arbitrary release/library filename, so the
 *  same movie or episode can be recognized across differently-named releases
 *  (e.g. "Film.2019.HEVC.mkv" vs "Film (2019) 1080p x264.mkv"). For movies, also
 *  returns the raw (unnormalized) title + year so callers can additionally try
 *  matching them against Radarr's own title/original title — release names are
 *  sometimes in a different language than the library's (French vs English), which
 *  the plain normalized-string key alone would treat as two unrelated movies. */
function parseReleaseKey(name: string): { key: string; kind: "movie" | "series"; rawTitle?: string; year?: number; episodeTag?: string } | null {
  const epMatch = name.match(EPISODE_TAG_RE) ?? name.match(EPISODE_TAG_NO_E_RE);
  if (epMatch) {
    const show = normalizeReleaseTitle(epMatch[1]);
    if (!show) return null;
    const tag = `S${epMatch[2].padStart(2, "0")}E${epMatch[3].padStart(3, "0")}`;
    return {
      key: `ep:${show}:${tag}`,
      kind: "series",
      rawTitle: epMatch[1].replace(/[._]/g, " ").trim(),
      episodeTag: tag,
    };
  }
  const movieMatch = name.match(YEAR_RE);
  if (movieMatch) {
    const year = parseInt(movieMatch[2]);
    if (year < 1900 || year > 2099) return null;
    const title = normalizeReleaseTitle(movieMatch[1]);
    if (!title) return null;
    return { key: `mv:${title}:${year}`, kind: "movie", rawTitle: movieMatch[1].replace(/[._]/g, " ").trim(), year };
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
      const full = path.join(root, e.name);
      try {
        const st = await fs.stat(full);
        return { name: e.name, relPath: path.relative(MEDIA_ROOT, full), size: st.size, dev: st.dev, ino: st.ino, nlink: st.nlink, mtimeMs: st.mtimeMs };
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
  const m = name.match(EPISODE_TAG_RE) ?? name.match(EPISODE_TAG_NO_E_RE);
  return m ? `${m[1].replace(/[._]/g, " ").trim()} · S${m[2].padStart(2, "0")}E${m[3].padStart(3, "0")}` : name;
}

async function computeStorageStats(): Promise<Omit<StorageStats, "computing">> {
  // Movie codec comes from Radarr's own mediaInfo (already fetched/cached elsewhere in
  // the app, one bulk call) — more reliable than filename sniffing, since Radarr often
  // renames files to "Title (Year).mkv" with no codec tag left in the name at all.
  // Series use the filename heuristic below: probing every episode's mediainfo, or
  // calling Sonarr per-series, made the scan too slow to be usable.
  const [movieItems, seriesItems, seedFiles, radarrMovies, sonarrSeries, qbTorrents] = await Promise.all([
    walkLibraryGrouped(MOVIES_PATH, "movie"),
    walkLibraryGrouped(TV_PATH, "series"),
    walkSeeds(),
    cachedMovies().catch(() => []),
    cachedSeries().catch(() => []),
    qbittorrent.getTorrents().catch(() => []),
  ]);

  // A seed-side file with no qBittorrent record at all is safe to delete outright; one that
  // still matches a live torrent should be removed there first (qBittorrent will otherwise
  // just re-seed the leftover, or the file will reappear if it re-checks the torrent). qBittorrent
  // names a torrent's save folder (or the file itself, for single-file torrents) after the
  // torrent's own name — matching against any path segment works regardless of nesting depth.
  const activeTorrentNames = new Set(qbTorrents.map((t) => t.name.trim().toLowerCase()));
  function isActiveInQbittorrent(relPaths: string[]): boolean {
    if (activeTorrentNames.size === 0) return false;
    for (const relPath of relPaths) {
      const segments = relPath.split("/");
      const fileNameNoExt = path.basename(relPath, path.extname(relPath)).toLowerCase();
      if (activeTorrentNames.has(fileNameNoExt)) return true;
      for (const seg of segments) {
        if (activeTorrentNames.has(seg.toLowerCase())) return true;
      }
    }
    return false;
  }

  // Release names aren't always in the same language as Radarr's own title (e.g. an
  // English-titled seed release vs. the library's French title) — the plain filename
  // key alone would treat them as two unrelated movies. Reuse the same fuzzy
  // localized/original-title matching used by search, keyed by year to keep it cheap.
  const hintsByYear = new Map<number, { id: number; title: string; originalTitle?: string }[]>();
  for (const m of radarrMovies) {
    const arr = hintsByYear.get(m.year);
    const hint = { id: m.id, title: m.title, originalTitle: m.originalTitle };
    if (arr) arr.push(hint);
    else hintsByYear.set(m.year, [hint]);
  }
  function resolveMovieHint(rawTitle: string, year: number) {
    let best: { id: number; title: string; originalTitle?: string } | null = null;
    let bestScore = 0;
    for (const c of hintsByYear.get(year) ?? []) {
      const score = bestTitleMatchScore([c.title, c.originalTitle], rawTitle);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore >= 75 ? best : null;
  }

  // Same idea as Radarr hints above, but for series: a season-pack seed's episode names are
  // sometimes in a different language/format than Sonarr's own title (e.g. an English release
  // for a show the library holds under its French title). Without this, dozens of episodes from
  // a legitimate season pack could be misclassified as seed orphans just because the title string
  // doesn't match byte-for-byte. Sonarr's series list is a single cached bulk call, so this stays cheap.
  const seriesHintCache = new Map<string, { id: number; title: string } | null>();
  function resolveSeriesHint(rawShow: string) {
    // "Intégrale" season-pack folders often embed a year in the show name itself (e.g.
    // "L'Attaque des Titans (2013)"), which titleMatchScore's substring check treats as an
    // extra token that breaks an otherwise-exact match against Sonarr's plain title — strip
    // it before matching.
    const stripped = rawShow.replace(/\s*[([]?(19|20)\d{2}[)\]]?\s*$/, "").trim() || rawShow;
    const cacheKey = normalizeReleaseTitle(stripped);
    if (seriesHintCache.has(cacheKey)) return seriesHintCache.get(cacheKey)!;
    let best: { id: number; title: string } | null = null;
    let bestScore = 0;
    for (const s of sonarrSeries) {
      // Release names are often scene/translated titles (e.g. a French season pack for a show
      // Sonarr tracks under its English title) — alternateTitles carries those localized names.
      const candidates = [s.title, ...(s.alternateTitles?.map((a) => a.title) ?? [])];
      const score = bestTitleMatchScore(candidates, stripped);
      if (score > bestScore) { bestScore = score; best = { id: s.id, title: s.title }; }
    }
    const result = bestScore >= 75 ? best : null;
    seriesHintCache.set(cacheKey, result);
    return result;
  }

  function resolveDisplayName(name: string): string {
    const parsed = parseReleaseKey(name);
    if (parsed?.kind === "movie" && parsed.rawTitle && parsed.year) {
      const hint = resolveMovieHint(parsed.rawTitle, parsed.year);
      if (hint) return `${hint.title} (${parsed.year})`;
    }
    if (parsed?.kind === "series" && parsed.rawTitle && parsed.episodeTag) {
      const hint = resolveSeriesHint(parsed.rawTitle);
      if (hint) return `${hint.title} · ${parsed.episodeTag}`;
    }
    return displayTitle(name);
  }
  /** Whether a release's title is recognized at all in Radarr/Sonarr — distinguishes a seed
   *  file that matches a known (but not-yet-imported) movie/show from a true orphan that
   *  matches nothing anywhere. */
  function isKnownInCatalog(name: string): boolean {
    const parsed = parseReleaseKey(name);
    if (!parsed) return false;
    if (parsed.kind === "movie" && parsed.rawTitle && parsed.year) {
      return resolveMovieHint(parsed.rawTitle, parsed.year) !== null;
    }
    if (parsed.kind === "series" && parsed.rawTitle) {
      return resolveSeriesHint(parsed.rawTitle) !== null;
    }
    return false;
  }

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
  const releaseGroups = new Map<string, { kind: "movie" | "series"; releases: { name: string; relPath: string; sizeBytes: number; inLibrary: boolean; invKey: string }[] }>();

  function addReleaseCandidate(name: string, relPath: string, dev: number, ino: number, size: number, inLibrary: boolean, fallbackKey?: string) {
    const invKey = `${dev}:${ino}`;
    if (releaseSeen.has(invKey)) return;
    releaseSeen.add(invKey);
    const parsed = parseReleaseKey(name) ?? (fallbackKey ? parseReleaseKey(fallbackKey) : null);
    if (!parsed) return;
    let key = parsed.key;
    if (parsed.kind === "movie" && parsed.rawTitle && parsed.year) {
      const hint = resolveMovieHint(parsed.rawTitle, parsed.year);
      if (hint) key = `mv:radarr:${hint.id}`;
    } else if (parsed.kind === "series" && parsed.rawTitle && parsed.episodeTag) {
      const hint = resolveSeriesHint(parsed.rawTitle);
      if (hint) key = `tv:sonarr:${hint.id}:${parsed.episodeTag}`;
    }
    let group = releaseGroups.get(key);
    if (!group) {
      group = { kind: parsed.kind, releases: [] };
      releaseGroups.set(key, group);
    }
    group.releases.push({ name, relPath, sizeBytes: size, inLibrary, invKey });
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
      else notHardlinked.push({ type: "movie", title: item.title, fileName: f.name, relativePath: f.relPath, sizeBytes: f.size });
      addReleaseCandidate(f.name, f.relPath, f.dev, f.ino, f.size, true, item.title);
    }
  }
  for (const item of seriesItems) {
    let h264Bytes = 0;
    for (const f of item.files) {
      libraryInodes.add(`${f.dev}:${f.ino}`);
      seriesTotal++; seriesBytes += f.size;
      if (f.nlink > 1) seriesHardlinked++;
      else notHardlinked.push({ type: "series", title: item.title, fileName: f.name, relativePath: f.relPath, sizeBytes: f.size });
      addReleaseCandidate(f.name, f.relPath, f.dev, f.ino, f.size, true);
      if (H264_RE.test(f.name)) h264Bytes += f.size;
    }
    if (h264Bytes > 0) heaviestH264.push({ type: "series", title: item.title, sizeBytes: h264Bytes });
  }
  heaviestH264.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const heaviestH264Top = heaviestH264.slice(0, 50);
  for (const f of seedFiles) {
    addReleaseCandidate(f.name, f.relPath, f.dev, f.ino, f.size, false);
  }

  // A file that matches another release of the same title/episode (whether that other
  // release is in the library or just another seed) is a duplicate, not an orphan —
  // "seed orphan" is reserved for a torrent that truly matches nothing anywhere.
  const duplicateInodes = new Set<string>();
  for (const group of releaseGroups.values()) {
    if (group.releases.length < 2) continue;
    for (const r of group.releases) duplicateInodes.add(r.invKey);
  }

  // Seed orphans: distinct seed-side files (by inode) with no library match and no
  // sibling release (same title/episode) anywhere else in the library or seed pool.
  const seedOrphanMap = new Map<string, { title: string; fileName: string; sizeBytes: number; trackers: Set<string>; paths: Set<string>; inCatalog: boolean }>();
  for (const f of seedFiles) {
    const key = `${f.dev}:${f.ino}`;
    if (libraryInodes.has(key) || duplicateInodes.has(key)) continue;
    let entry = seedOrphanMap.get(key);
    if (!entry) {
      entry = { title: resolveDisplayName(f.name), fileName: f.name, sizeBytes: f.size, trackers: new Set(), paths: new Set(), inCatalog: isKnownInCatalog(f.name) };
      seedOrphanMap.set(key, entry);
    }
    entry.paths.add(f.relPath);
    if (f.origin === "cross-seed" && f.tracker) entry.trackers.add(f.tracker);
  }
  const seedOrphans = [...seedOrphanMap.values()]
    .map((o) => {
      const paths = [...o.paths];
      return {
        title: o.title, fileName: o.fileName, paths, sizeBytes: o.sizeBytes,
        trackers: [...o.trackers], inCatalog: o.inCatalog,
        activeInQbittorrent: isActiveInQbittorrent(paths),
      };
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const seedOrphanBytes = seedOrphans.reduce((s, o) => s + o.sizeBytes, 0);

  // Cross-seed grouped by tracker
  const trackerMap = new Map<string, { totalBytes: number; files: { title: string; fileName: string; relativePath: string; sizeBytes: number; linkedToLibrary: boolean }[] }>();
  for (const f of seedFiles) {
    if (f.origin !== "cross-seed" || !f.tracker) continue;
    let group = trackerMap.get(f.tracker);
    if (!group) {
      group = { totalBytes: 0, files: [] };
      trackerMap.set(f.tracker, group);
    }
    group.totalBytes += f.size;
    group.files.push({ title: resolveDisplayName(f.name), fileName: f.name, relativePath: f.relPath, sizeBytes: f.size, linkedToLibrary: libraryInodes.has(`${f.dev}:${f.ino}`) });
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
    const title = resolveDisplayName(sorted[0].name) || key;
    duplicates.push({
      type: group.kind,
      title,
      wastedBytes,
      releases: sorted.map(({ name, relPath, sizeBytes, inLibrary }) => ({ name, relativePath: relPath, sizeBytes, inLibrary })),
    });
  }
  duplicates.sort((a, b) => b.wastedBytes - a.wastedBytes);

  notHardlinked.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const monthlyGrowth = computeMonthlyGrowth([...movieItems, ...seriesItems]);

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
    monthlyGrowth,
  };
}

const MONTHLY_GROWTH_MONTHS = 12;

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Buckets library file bytes by the month they were added (mtime), for the last
 *  MONTHLY_GROWTH_MONTHS months — including months with zero additions, so callers get a
 *  fixed-length, chronologically contiguous series without having to fill gaps themselves. */
function computeMonthlyGrowth(items: LibraryItem[]): { month: string; bytes: number }[] {
  const now = new Date();
  const buckets = new Map<string, number>();
  for (let i = MONTHLY_GROWTH_MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, 0);
  }

  const oldestKey = [...buckets.keys()][0];
  for (const item of items) {
    for (const f of item.files) {
      const key = monthKey(f.mtimeMs);
      // Anything older than the tracked window collapses into "before the chart" — irrelevant
      // to a recent monthly-growth rate, and Map insertion order would otherwise put it first
      // instead of dropping it.
      if (key < oldestKey) continue;
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + f.size);
    }
  }

  return [...buckets.entries()].map(([month, bytes]) => ({ month, bytes }));
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
  monthlyGrowth: [],
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
