import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import { bazarr } from "@/lib/clients/bazarr";
import { jackett } from "@/lib/clients/jackett";
import { jellyfin } from "@/lib/clients/jellyfin";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { qbittorrent } from "@/lib/clients/qbittorrent";
import { tmdb } from "@/lib/clients/tmdb";
import { omdb } from "@/lib/clients/omdb";
import { withCacheSafe, cachedMovies, cachedSeries, TTL } from "@/lib/server-cache";
import { getDiskStats, type DiskStats } from "@/lib/disk-stats";
import { classifyError } from "@/lib/api-error";
import { posterUrl } from "@/lib/images";
import { config } from "@/lib/config";

// Checked before any network call so "not configured" never gets confused
// with "configured but unreachable" — both would otherwise surface as the
// same generic connection error. See README > Deployment for the .env vars.
function notConfigured(envVar: string): Error {
  return new Error(`Non configuré — définis ${envVar} dans .env (voir README > Deployment)`);
}

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ServiceStatus {
  name: string;
  up: boolean;
  detail?: string;
  stats?: Record<string, number | string>;
}

export interface ActivityItem {
  id: string;
  date: string;
  source: "radarr" | "sonarr" | "jellyseerr";
  type: string;
  title: string;
  detail?: string;
  href?: string;
}

export interface ResumeItem {
  id: string;
  name: string;
  subtitle: string | null;
  type: string;
  progress: number;
  positionTicks: number;
  runtimeTicks: number;
  imageTag: string | null;
  cinemaHref: string | null;
}

export interface RecentItem {
  id: number;
  title: string;
  year: number;
  added?: string;
  hasFile?: boolean;
  status?: string;
  posterUrl: string | null;
}

export interface TorrentItem {
  hash: string;
  name: string;
  state: string;
  progress: number;
  dlspeed: number;
  upspeed: number;
  size: number;
  eta: number;
}

export type { DiskStats };

export interface DashboardSection<T> {
  data: T | null;
  available: boolean;
  error: string | null;
  updatedAt: number | null;
  stale: boolean;
}

export interface DashboardPayload {
  services:       DashboardSection<ServiceStatus[]>;
  activity:       DashboardSection<ActivityItem[]>;
  resume:         DashboardSection<{ items: ResumeItem[] }>;
  recentMovies:   DashboardSection<RecentItem[]>;
  recentSeries:   DashboardSection<RecentItem[]>;
  torrents:       DashboardSection<TorrentItem[]>;
  disk:           DashboardSection<DiskStats>;
}

// ─── Service status probe ─────────────────────────────────────────────────────

async function probeServices(): Promise<ServiceStatus[]> {
  return Promise.all([
    probe("radarr", async () => {
      if (!config.radarr.apiKey) throw notConfigured("RADARR_API_KEY");
      const [status, movies, missing, queue] = await Promise.all([
        radarr.getSystemStatus(),
        radarr.getMovies(),
        radarr.getMissingCount().catch(() => 0),
        radarr.getQueueCount().catch(() => 0),
      ]);
      return { detail: `v${status.version}`, stats: { Films: movies.length, Manquants: missing, "En téléchargement": queue } };
    }),
    probe("sonarr", async () => {
      if (!config.sonarr.apiKey) throw notConfigured("SONARR_API_KEY");
      const [status, series, missing, queue] = await Promise.all([
        sonarr.getSystemStatus(),
        sonarr.getSeries(),
        sonarr.getMissingCount().catch(() => 0),
        sonarr.getQueueCount().catch(() => 0),
      ]);
      return { detail: `v${status.version}`, stats: { Séries: series.length, "Épisodes manquants": missing, "En téléchargement": queue } };
    }),
    probe("bazarr", async () => {
      if (!config.bazarr.apiKey) throw notConfigured("BAZARR_API_KEY");
      const [movies, episodes] = await Promise.all([bazarr.getWantedMovies(), bazarr.getWantedEpisodes()]);
      return { stats: { "Films sans sous-titres": movies.total, "Épisodes sans sous-titres": episodes.total } };
    }),
    probe("jackett", async () => {
      if (!config.jackett.apiKey) throw notConfigured("JACKETT_API_KEY");
      const indexers = await jackett.getIndexers();
      return { detail: `${indexers.length} indexeurs`, stats: { Indexeurs: indexers.length } };
    }),
    probe("jellyfin", async () => {
      if (!config.jellyfin.apiKey) throw notConfigured("JELLYFIN_API_KEY");
      const [info, counts, sessions] = await Promise.all([
        jellyfin.getSystemInfo(),
        jellyfin.getLibraryCounts(),
        jellyfin.getSessions(),
      ]);
      const active = sessions.filter((s) => s.NowPlayingItem).length;
      return { detail: `v${info.Version}`, stats: { Films: counts.MovieCount, Séries: counts.SeriesCount, "Lectures actives": active } };
    }),
    probe("jellyseerr", async () => {
      if (!config.jellyseerr.apiKey) throw notConfigured("JELLYSEERR_API_KEY");
      const [status, pending] = await Promise.all([jellyseerr.getStatus(), jellyseerr.getRequests("pending")]);
      return { detail: `v${status.version}`, stats: { "Demandes en attente": pending.pageInfo?.results ?? pending.results.length } };
    }),
    probe("qbittorrent", async () => {
      if (!config.qbittorrent.password) throw notConfigured("QBITTORRENT_PASSWORD");
      const [transfer, torrents] = await Promise.all([qbittorrent.getTransferInfo(), qbittorrent.getTorrents()]);
      const downloading = torrents.filter((t) => /downloading|dl$/i.test(t.state)).length;
      const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB/s`;
      return { stats: { Torrents: torrents.length, "En téléchargement": downloading, "↓": fmt(transfer.dl_info_speed), "↑": fmt(transfer.up_info_speed) } };
    }),
    probe("tmdb", async () => {
      if (!tmdb.isEnabled()) throw notConfigured("TMDB_API_KEY");
      const auth = await tmdb.checkAuth();
      if (!auth.success) throw new Error("Clé API invalide");
      return { detail: "Clé API valide" };
    }),
    probe("omdb", async () => {
      if (!omdb.isEnabled()) throw notConfigured("OMDB_API_KEY");
      const res = await omdb.checkKey();
      if (res.Response !== "True") throw new Error("Clé API invalide");
      return { detail: "Clé API valide" };
    }),
  ]);
}

async function probe(
  name: string,
  fn: () => Promise<{ detail?: string; stats?: Record<string, number | string> }>
): Promise<ServiceStatus> {
  try {
    const { detail, stats } = await fn();
    return { name, up: true, detail, stats };
  } catch (err) {
    const e = classifyError(err);
    // Prefer the specific technical detail (e.g. "définis RADARR_API_KEY...")
    // over the generic classified label so the user knows exactly what to fix.
    return { name, up: false, detail: e.detail ?? e.message };
  }
}

// ─── Activity ─────────────────────────────────────────────────────────────────

const RADARR_LABELS: Record<string, string> = {
  grabbed: "Récupéré", downloadFolderImported: "Importé",
  movieFileDeleted: "Supprimé", movieFolderImported: "Importé", downloadFailed: "Téléchargement échoué",
};
const SONARR_LABELS: Record<string, string> = {
  grabbed: "Récupéré", downloadFolderImported: "Importé",
  episodeFileDeleted: "Supprimé", downloadFailed: "Téléchargement échoué",
};

async function fetchActivity(): Promise<ActivityItem[]> {
  const [rH, sH, jsR] = await Promise.all([
    radarr.getHistory(15).catch(() => ({ records: [] })),
    sonarr.getHistory(15).catch(() => ({ records: [] })),
    jellyseerr.getRequests("all").catch(() => ({ results: [] })),
  ]);
  const items: ActivityItem[] = [];
  for (const r of rH.records) {
    items.push({ id: `radarr-${r.id}`, date: r.date, source: "radarr", type: RADARR_LABELS[r.eventType] ?? r.eventType, title: r.movie?.title ?? r.sourceTitle, detail: r.eventType === "grabbed" ? r.data?.indexer : undefined, href: r.movie?.id ? `/radarr/${r.movie.id}` : undefined });
  }
  for (const r of sH.records) {
    items.push({ id: `sonarr-${r.id}`, date: r.date, source: "sonarr", type: SONARR_LABELS[r.eventType] ?? r.eventType, title: r.series?.title ?? r.sourceTitle, detail: r.episode ? `S${String(r.episode.seasonNumber).padStart(2,"0")}E${String(r.episode.episodeNumber).padStart(2,"0")}` : undefined, href: r.series?.id ? `/sonarr/${r.series.id}` : undefined });
  }
  for (const req of jsR.results.slice(0, 15)) {
    items.push({ id: `jellyseerr-${req.id}`, date: req.createdAt, source: "jellyseerr", type: "Demande", title: req.media.title ?? "Demande média", detail: req.requestedBy?.displayName ?? req.requestedBy?.username, href: "/jellyseerr" });
  }
  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items.slice(0, 25);
}

// ─── Resume ───────────────────────────────────────────────────────────────────

async function fetchResume(jfId: string): Promise<{ items: ResumeItem[] }> {
  const [resumeData, movies, series] = await Promise.all([
    jellyfin.getResumeItems(jfId).catch(() => ({ Items: [] })),
    cachedMovies().catch(() => []),
    cachedSeries().catch(() => []),
  ]);
  const moviesByTmdb = new Map(movies.map((m) => [m.tmdbId, m.id]));
  const seriesByTvdb = new Map(series.map((s) => [s.tvdbId, s.id]));

  // Jellyfin never puts ProviderIds on Episode items, only on their parent
  // Series — fetch the series' TVDB id separately (deduped) so episodes in
  // the resume list can still link to their series' sheet.
  const episodeSeriesIds = [...new Set(
    resumeData.Items.filter((i) => i.Type === "Episode" && i.SeriesId).map((i) => i.SeriesId!)
  )];
  const seriesTvdbById = new Map<string, number | undefined>();
  await Promise.all(episodeSeriesIds.map(async (seriesId) => {
    const providerIds = await jellyfin.getItemProviderIds(jfId, seriesId).catch(() => null);
    const tvdb = providerIds?.ProviderIds?.Tvdb;
    if (tvdb) seriesTvdbById.set(seriesId, parseInt(tvdb, 10));
  }));

  const items: ResumeItem[] = resumeData.Items.map((item) => {
    const pos = item.UserData?.PlaybackPositionTicks ?? 0;
    const rt = item.RunTimeTicks ?? 0;
    const progress = rt > 0 ? Math.min((pos / rt) * 100, 99) : 0;
    let cinemaHref: string | null = null;
    if (item.Type === "Movie" && item.ProviderIds?.Tmdb) {
      const id = moviesByTmdb.get(parseInt(item.ProviderIds.Tmdb, 10));
      if (id) cinemaHref = `/radarr/${id}`;
    } else if (item.Type === "Series" && item.ProviderIds?.Tvdb) {
      const id = seriesByTvdb.get(parseInt(item.ProviderIds.Tvdb, 10));
      if (id) cinemaHref = `/sonarr/${id}`;
    } else if (item.Type === "Episode" && item.SeriesId) {
      const tvdb = seriesTvdbById.get(item.SeriesId);
      const id = tvdb ? seriesByTvdb.get(tvdb) : undefined;
      if (id) cinemaHref = `/sonarr/${id}`;
    }
    return { id: item.Id, name: item.Type === "Episode" && item.SeriesName ? item.SeriesName : item.Name, subtitle: item.Type === "Episode" ? `S${String(item.ParentIndexNumber ?? 1).padStart(2,"0")}E${String(item.IndexNumber ?? 1).padStart(2,"0")} · ${item.Name}` : null, type: item.Type ?? "Unknown", progress: Math.round(progress), positionTicks: pos, runtimeTicks: rt, imageTag: item.ImageTags?.Primary ?? null, cinemaHref };
  });
  return { items };
}

// ─── Recent movies / series ───────────────────────────────────────────────────

async function fetchRecentMovies(): Promise<RecentItem[]> {
  const movies = await cachedMovies();
  return movies
    .filter((m) => m.added && m.added !== "0001-01-01T00:00:00Z")
    .sort((a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime())
    .slice(0, 8)
    .map((m) => ({ id: m.id, title: m.title, year: m.year, added: m.added, hasFile: m.hasFile, posterUrl: posterUrl(m.images, "thumb") }));
}

async function fetchRecentSeries(): Promise<RecentItem[]> {
  const series = await cachedSeries();
  return series
    .filter((s) => s.added && s.added !== "0001-01-01T00:00:00Z")
    .sort((a, b) => new Date(b.added!).getTime() - new Date(a.added!).getTime())
    .slice(0, 8)
    .map((s) => ({ id: s.id, title: s.title, year: s.year, added: s.added, status: s.status, posterUrl: posterUrl(s.images, "thumb") }));
}

// ─── Torrents ─────────────────────────────────────────────────────────────────

async function fetchTorrents(): Promise<TorrentItem[]> {
  const torrents = await qbittorrent.getTorrents();
  return torrents.map((t) => ({
    hash: t.hash, name: t.name, state: t.state,
    progress: t.progress, dlspeed: t.dlspeed, upspeed: t.upspeed,
    size: t.size, eta: t.eta,
  }));
}

// ─── Disk stats ───────────────────────────────────────────────────────────────

// disk-stats.ts has its own cache with background compute — don't wrap in withCacheSafe
function getDiskSection(): DashboardSection<DiskStats> {
  try {
    const data = getDiskStats();
    return { data, available: true, error: data.error, updatedAt: data.computedAt || null, stale: false };
  } catch (err) {
    const e = classifyError(err);
    return { data: null, available: false, error: e.message, updatedAt: null, stale: false };
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

// Shared by the API route and the dashboard page's server-side initial render
// (see (dashboard)/page.tsx) — both read through the exact same in-memory
// caches in server-cache.ts, so calling this a second time from the page is
// normally a cache hit, not a duplicate fetch.
export async function buildDashboardPayload(
  session: { jfId?: string } | null
): Promise<DashboardPayload> {
  const [services, activity, recentMovies, recentSeries, torrents] = await Promise.all([
    withCacheSafe("dashboard:services",      TTL.SHORT,      probeServices),
    withCacheSafe("dashboard:activity",      TTL.MEDIUM,     fetchActivity),
    withCacheSafe("dashboard:recent:movies", TTL.MEDIUM,     fetchRecentMovies),
    withCacheSafe("dashboard:recent:series", TTL.MEDIUM,     fetchRecentSeries),
    withCacheSafe("dashboard:torrents",      TTL.VERY_SHORT, fetchTorrents),
  ]);
  const disk = getDiskSection();

  const resume = session?.jfId
    ? await withCacheSafe(`dashboard:resume:${session.jfId}`, TTL.SHORT, () => fetchResume(session.jfId!))
    : { data: { items: [] }, available: true, error: null, updatedAt: null, stale: false };

  return { services, activity, resume, recentMovies, recentSeries, torrents, disk };
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  const payload = await buildDashboardPayload(session);
  return NextResponse.json(payload);
}
