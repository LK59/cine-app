import fs from "fs/promises";
import path from "path";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { bestTitleMatchScore } from "@/lib/search-natural-query";
import { qbittorrent } from "@/lib/clients/qbittorrent";
import { sonarr } from "@/lib/clients/sonarr";
import { getTitleNames } from "@/lib/titleNames";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import { MEDIA_ROOT, MOVIES_PATH, TV_PATH, SEED_MOVIES_PATH, SEED_TV_PATH, CROSS_SEED_PATH } from "@/lib/media-paths";

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

export interface FileStat {
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

export interface LibraryItem {
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
  /** Octets de la bibliothèque rangés par mois d'**import** (date d'ajout Radarr/Sonarr du fichier,
   *  sa date de modification à défaut), du plus ancien au plus récent, clés « AAAA-MM » comme les
   *  autres graphiques mensuels. Douze derniers mois. Voir `computeMonthlyGrowth`. */
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
  const hintsByYear = new Map<number, MovieHint[]>();
  for (const m of radarrMovies) {
    const arr = hintsByYear.get(m.year);
    const hint = movieHintOf(m);
    if (arr) arr.push(hint);
    else hintsByYear.set(m.year, [hint]);
  }
  function resolveMovieHint(rawTitle: string, year: number) {
    let best: MovieHint | null = null;
    let bestScore = 0;
    for (const c of hintsByYear.get(year) ?? []) {
      const score = bestTitleMatchScore(c.titles, rawTitle);
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
    const yearMatch = rawShow.match(/\s*[([]?((?:19|20)\d{2})[)\]]?\s*$/);
    const stripped = rawShow.replace(/\s*[([]?(19|20)\d{2}[)\]]?\s*$/, "").trim() || rawShow;
    const year = yearMatch ? parseInt(yearMatch[1]) : null;
    // La clé garde l'année : « Gossip Girl » et « Gossip Girl (2021) » sont deux séries.
    const cacheKey = normalizeReleaseTitle(rawShow);
    if (seriesHintCache.has(cacheKey)) return seriesHintCache.get(cacheKey)!;
    let best: { id: number; title: string } | null = null;
    let bestScore = 0;
    for (const s of sonarrSeries) {
      // Release names are often scene/translated titles (e.g. a French season pack for a show
      // Sonarr tracks under its English title) — alternateTitles carries those localized names.
      const candidates = [s.title, ...(s.alternateTitles?.map((a) => a.title) ?? [])];
      // L'année retirée ne doit pas effacer ce qu'elle distingue. Sonarr nomme le remake
      // « Gossip Girl (2021) » : comparé au seul « Gossip Girl », il perdait (90) contre la série
      // de 2007 (100), et les 22 épisodes des deux séries — des fichiers différents — sortaient
      // comme 22 doublons, ~50 Go « en trop » qui n'existaient pas (vérifié le 13/10/2026).
      // On garde donc le meilleur des deux libellés, et l'année identique départage.
      let score = Math.max(bestTitleMatchScore(candidates, stripped), bestTitleMatchScore(candidates, rawShow));
      if (score > 0 && year !== null && s.year === year) score += 1;
      if (score > bestScore) { bestScore = score; best = { id: s.id, title: s.title }; }
    }
    const result = bestScore >= 75 ? best : null;
    seriesHintCache.set(cacheKey, result);
    return result;
  }

  // Un fichier de la bibliothèque n'a pas à deviner sa série : son dossier est celui que Sonarr
  // lui a donné (`path`). Le rapprochement par titre reste pour les seeds, qui n'en ont pas.
  const seriesByFolder = new Map<string, { id: number; title: string }>();
  for (const s of sonarrSeries) {
    if (s.path) seriesByFolder.set(path.basename(s.path), { id: s.id, title: s.title });
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

  function addReleaseCandidate(name: string, relPath: string, dev: number, ino: number, size: number, inLibrary: boolean, fallbackKey?: string, seriesFolder?: string) {
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
      const hint = (seriesFolder ? seriesByFolder.get(seriesFolder) : undefined) ?? resolveSeriesHint(parsed.rawTitle);
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

  // Les compteurs « hardlinkés x / y » comptent des fichiers, pas des chemins : un même inode lié
  // sous deux dossiers de la bibliothèque était compté deux fois, et toujours comme « hardlinké »
  // puisque ses deux noms suffisent à porter nlink à 2. 17 ici (13/10/2026) : « Berlin (2023) »
  // S02 et « Le Flambeau » / « Burning Love (FR) » S02, chacun doublé par un dossier que Sonarr ne
  // suit pas (« Berlin and the Lady with an Ermine », « Le Flambeau ») mais que Jellyfin montre
  // comme une série à part — Sonarr, lui, n'a qu'une série pour chaque paire.
  for (const item of movieItems) {
    for (const f of item.files) {
      if (libraryInodes.has(`${f.dev}:${f.ino}`)) continue;
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
      if (libraryInodes.has(`${f.dev}:${f.ino}`)) continue;
      libraryInodes.add(`${f.dev}:${f.ino}`);
      seriesTotal++; seriesBytes += f.size;
      if (f.nlink > 1) seriesHardlinked++;
      else notHardlinked.push({ type: "series", title: item.title, fileName: f.name, relativePath: f.relPath, sizeBytes: f.size });
      addReleaseCandidate(f.name, f.relPath, f.dev, f.ino, f.size, true, undefined, item.title);
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
    // « En trop » = ce que libère la suppression des autres copies, en gardant celle que la
    // bibliothèque lit (la plus grosse d'entre elles s'il y en a plusieurs). Garder d'office la plus
    // grosse donnait l'inverse quand le seed pèse plus que le fichier importé : « The Exorcist »
    // affichait 8,9 Go en trop — la taille du fichier de la bibliothèque, qu'on ne supprime pas —
    // alors que c'est le seed de 14,8 Go qui est en double.
    const kept = sorted.find((r) => r.inLibrary) ?? sorted[0];
    const wastedBytes = sorted.reduce((s, r) => (r === kept ? s : s + r.sizeBytes), 0);
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

  const addedAt = await libraryDatesAdded(radarrMovies, sonarrSeries);
  const monthlyGrowth = computeMonthlyGrowth([...movieItems, ...seriesItems], (item, f) =>
    addedAt.get(libraryKey(item.type, f.relPath)));

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

interface MovieHint { id: number; title: string; titles: string[] }

/**
 * Les noms sous lesquels une release peut désigner ce film : titre Radarr, titre original, titres
 * alternatifs de Radarr, et le titre du film dans chaque langue de l'interface (`titleNames`, cache
 * TMDB déjà tenu pour le catalogue — jamais bloquant, il ne lance aucun appel ici qu'il n'aurait
 * lancé pour le catalogue).
 *
 * Le seed « Dernier.train.pour.Busan.2016…AV1-ASKO.mkv » sortait comme orphelin (13/10/2026) alors
 * que le film est dans la bibliothèque sous « Train to Busan » : ni le titre Radarr, ni l'original
 * (« 부산행 »), ni aucun des 26 titres alternatifs de Radarr n'est le titre français. C'est une autre
 * release du même film (autre inode : AV1, 7,9 Go, contre le x265 de 6,9 Go importé) — un doublon,
 * pas un orphelin. L'année identique reste exigée, et le seuil de 75 aussi.
 */
function movieHintOf(m: RadarrMovie): MovieHint {
  const titles = new Set<string>();
  const add = (t: string | undefined) => { if (t?.trim()) titles.add(t.trim()); };
  add(m.title);
  add(m.originalTitle);
  for (const a of m.alternateTitles ?? []) add(a.title);
  const names = getTitleNames(m.tmdbId, "movie");
  for (const locale of ["fr", "en", "es", "de"] as const) add(names[locale]);
  return { id: m.id, title: m.title, titles: [...titles] };
}

/** La clé commune d'un fichier de la bibliothèque, vu du disque ou de Radarr/Sonarr : « movie: » ou
 *  « series: » puis le chemin sous la racine des films ou des séries (`<dossier>/<chemin relatif>`).
 *  Radarr et Sonarr voient le disque sous une autre racine (`/media/…`) : seul ce qui suit compte. */
function libraryKey(type: "movie" | "series", relPathFromMediaRoot: string): string {
  const root = type === "movie" ? MOVIES_PATH : TV_PATH;
  return `${type}:${path.relative(root, path.join(MEDIA_ROOT, relPathFromMediaRoot))}`;
}

const EPISODE_FILES_CONCURRENCY = 6;

/**
 * La date d'import de chaque fichier de la bibliothèque, selon Radarr (`movieFile.dateAdded`, déjà
 * dans la liste des films) et Sonarr (`episodefile`, un appel par série : ~170 ici, 1,2 s en
 * parallèle mesuré le 13/10/2026 ; six à la fois, dans une analyse qui tourne au plus toutes les
 * 30 minutes). Une série que Sonarr ne rend pas laisse ses fichiers à leur date de modification.
 */
async function libraryDatesAdded(movies: RadarrMovie[], series: SonarrSeries[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const put = (key: string, iso: string | undefined) => {
    const ms = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(ms)) out.set(key, ms);
  };
  for (const m of movies) {
    if (m.path && m.movieFile?.relativePath) put(`movie:${path.basename(m.path)}/${m.movieFile.relativePath}`, m.movieFile.dateAdded);
  }
  const queue = series.filter((s) => s.path);
  async function worker() {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const folder = path.basename(s.path!);
      try {
        for (const f of await sonarr.getEpisodeFiles(s.id)) put(`series:${folder}/${f.relativePath}`, f.dateAdded);
      } catch {
        // Sonarr injoignable ou série disparue entre-temps : la date de modification servira.
      }
    }
  }
  await Promise.all(Array.from({ length: EPISODE_FILES_CONCURRENCY }, worker));
  return out;
}

const MONTHLY_GROWTH_MONTHS = 12;

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Les octets de la bibliothèque rangés par mois d'arrivée, sur les MONTHLY_GROWTH_MONTHS derniers
 * mois — mois vides compris, pour une série continue (la prévision de saturation compte un mois
 * sans ajout pour zéro).
 *
 * **Le mois d'arrivée est la date d'import, pas la date de modification** (13/10/2026). FileFlows
 * réencode en HEVC des fichiers déjà là, souvent plus petits : le fichier réécrit prenait la date du
 * jour et comptait comme un ajout entier ce mois-là, alors que la bibliothèque, elle, avait
 * maigri. Relevé sur le disque : en mars 2026, 647 Go de « croissance » étaient 273 fichiers
 * réencodés, importés des mois plus tôt (2 144 Go comptés pour 1 203 réellement importés) ; en
 * juillet, 126 Go. Radarr et Sonarr gardent la date d'import d'un fichier qu'ils relisent après
 * réencodage (161 films vérifiés : taille à jour, date d'ajout inchangée).
 *
 * Chaque fichier compte une fois (par inode : un épisode lié sous deux séries est un seul fichier),
 * à sa taille actuelle. Un remplacement par Radarr/Sonarr (meilleure release) crée un nouveau
 * fichier daté de son import : il compte entier ce mois-là, et le fichier remplacé, disparu, n'est
 * plus compté nulle part — la somme des mois reste la taille réelle de la bibliothèque. `addedAt`
 * rend la date d'import si Radarr/Sonarr connaissent ce chemin ; sinon (aucun de ses chemins
 * connu), la date de modification sert.
 */
export function computeMonthlyGrowth(
  items: LibraryItem[],
  addedAt: (item: LibraryItem, f: FileStat) => number | undefined = () => undefined,
  now = new Date(),
): { month: string; bytes: number }[] {
  const buckets = new Map<string, number>();
  for (let i = MONTHLY_GROWTH_MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, 0);
  }

  const oldestKey = [...buckets.keys()][0];
  // A hardlinked file can legitimately show up under more than one library path (e.g. the same
  // episode file linked into both a season folder and a "complete series" pack) — (dev, ino)
  // identifies the actual physical file regardless of how many names point at it, so each one
  // is only ever counted once here. Parmi ses chemins, celui que Radarr/Sonarr connaissent donne
  // la date : « Berlin and the Lady with an Ermine/… », dossier hors Sonarr lié au même inode que
  // « Berlin (2023)/Season 2/… », ne doit pas imposer sa date de modification s'il est lu en premier.
  const files = new Map<string, { size: number; addedAt?: number; mtimeMs: number }>();
  for (const item of items) {
    for (const f of item.files) {
      const inodeKey = `${f.dev}:${f.ino}`;
      const known = files.get(inodeKey);
      const date = addedAt(item, f);
      if (!known) files.set(inodeKey, { size: f.size, addedAt: date, mtimeMs: f.mtimeMs });
      else if (known.addedAt === undefined && date !== undefined) known.addedAt = date;
    }
  }
  for (const f of files.values()) {
    const key = monthKey(f.addedAt ?? f.mtimeMs);
    // Anything older than the tracked window collapses into "before the chart" — irrelevant
    // to a recent monthly-growth rate, and Map insertion order would otherwise put it first
    // instead of dropping it.
    if (key < oldestKey) continue;
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + f.size);
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
