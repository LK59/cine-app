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
import { atMostEvery } from "@/lib/quotaGuard";
import { omdb } from "@/lib/clients/omdb";
import { withCacheSafe, TTL } from "@/lib/server-cache";
import { getDiskStats, type DiskStats } from "@/lib/disk-stats";
import { classifyError } from "@/lib/api-error";
import { config } from "@/lib/config";
import { getJellyseerrPendingCount, getJellyseerrActivityItems } from "@/lib/jellyseerr-scope";
import type { SessionPayload } from "@/lib/auth";

// Checked before any network call so "not configured" never gets confused
// with "configured but unreachable" — both would otherwise surface as the
// same generic connection error. Le nom de la variable reste dans le message (c'est lui qu'on
// cherche dans `.env`), mais le réglage se fait d'abord dans Configuration → Connexions
// (DECISIONS.md §48) : renvoyer seulement vers `.env` envoyait l'administrateur au mauvais endroit.
function notConfigured(envVar: string): Error {
  return new Error(`Non configuré — ${envVar} (Configuration → Connexions, ou .env)`);
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
  /** Un `ActivityKind` — ou, pour un événement que personne n'a prévu, le nom brut de Sonarr/Radarr. */
  type: string;
  title: string;
  detail?: string;
  href?: string;
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

/**
 * L'accueil de la gestion : ce qui tourne (13/10/2026, DECISIONS.md §81). La bannière, Reprendre,
 * Ma liste et les ajouts récents en affiches sont partis — c'est le cinéma qui les montre, à tous
 * les comptes ; ils coûtaient ici une recherche de logo TMDB et de notes IMDb par titre à chaque
 * rafraîchissement d'un écran d'administration.
 */
export interface DashboardPayload {
  services:       DashboardSection<ServiceStatus[]>;
  activity:       DashboardSection<ActivityItem[]>;
  torrents:       DashboardSection<TorrentItem[]>;
  disk:           DashboardSection<DiskStats>;
}

// ─── Service status probe ─────────────────────────────────────────────────────

async function probeServices(session: SessionPayload | null): Promise<ServiceStatus[]> {
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
      // Pas de `detail` : il répétait mot pour mot le chiffre juste en dessous.
      return { stats: { Indexeurs: indexers.length } };
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
      // Admin sees the instance-wide pending count (what they're there to manage); anyone else
      // sees only their own — this fork gates listing other users' requests behind admin
      // permissions anyway, matching the same per-user session-cookie auth used for requests.
      const [status, pendingCount] = await Promise.all([jellyseerr.getStatus(), getJellyseerrPendingCount(session)]);
      return { detail: `v${status.version}`, stats: { "Demandes en attente": pendingCount } };
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
      // Au plus une fois par heure : cette vue se rafraîchit toutes les quinze secondes.
      const auth = await atMostEvery("key:tmdb", () => tmdb.checkAuth(), { isOk: (a) => a.success });
      if (!auth.success) throw new Error("Clé API invalide");
      return { detail: "Clé API valide" };
    }),
    probe("omdb", async () => {
      if (!omdb.isEnabled()) throw notConfigured("OMDB_API_KEY");
      // Au plus une fois par heure : quatre vérifications par minute épuisaient le quota d'OMDb.
      const res = await atMostEvery("key:omdb", () => omdb.checkKey(), { isOk: (r) => r.Response === "True" });
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

/**
 * Le *genre* d'événement, pas son libellé : l'écran le traduit (`activity.*`). Ces libellés étaient
 * écrits ici en français, et la vue d'ensemble les montrait tels quels dans les quatre langues —
 * alors que le groupe `activity` des dictionnaires existait exactement pour eux, sans servir.
 */
export type ActivityKind = "grabbed" | "imported" | "deleted" | "downloadFailed" | "request";

const RADARR_KINDS: Record<string, ActivityKind> = {
  grabbed: "grabbed", downloadFolderImported: "imported",
  movieFileDeleted: "deleted", movieFolderImported: "imported", downloadFailed: "downloadFailed",
};
const SONARR_KINDS: Record<string, ActivityKind> = {
  grabbed: "grabbed", downloadFolderImported: "imported",
  episodeFileDeleted: "deleted", downloadFailed: "downloadFailed",
};

async function fetchActivity(session: SessionPayload | null): Promise<ActivityItem[]> {
  const [rH, sH, jsRequests] = await Promise.all([
    radarr.getHistory(15).catch(() => ({ records: [] })),
    sonarr.getHistory(15).catch(() => ({ records: [] })),
    // Admin sees everyone's requests (with who asked, matching the requester name shown below);
    // anyone else only sees their own — same reasoning as the pending-count widget above.
    getJellyseerrActivityItems(session, 15),
  ]);
  const items: ActivityItem[] = [];
  for (const r of rH.records) {
    items.push({ id: `radarr-${r.id}`, date: r.date, source: "radarr", type: RADARR_KINDS[r.eventType] ?? r.eventType, title: r.movie?.title ?? r.sourceTitle, detail: r.eventType === "grabbed" ? r.data?.indexer : undefined, href: r.movie?.id ? `/radarr/${r.movie.id}` : undefined });
  }
  for (const r of sH.records) {
    items.push({ id: `sonarr-${r.id}`, date: r.date, source: "sonarr", type: SONARR_KINDS[r.eventType] ?? r.eventType, title: r.series?.title ?? r.sourceTitle, detail: r.episode ? `S${String(r.episode.seasonNumber).padStart(2,"0")}E${String(r.episode.episodeNumber).padStart(2,"0")}` : undefined, href: r.series?.id ? `/sonarr/${r.series.id}` : undefined });
  }
  for (const req of jsRequests) {
    items.push({ id: `jellyseerr-${req.id}`, date: req.createdAt, source: "jellyseerr", type: "request", title: req.media.title ?? "—", detail: req.requestedBy?.displayName ?? req.requestedBy?.username, href: "/jellyseerr" });
  }
  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return items.slice(0, 25);
}

// ─── Resume ───────────────────────────────────────────────────────────────────

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
  session: SessionPayload | null
): Promise<DashboardPayload> {
  // services/activity now carry Jellyseerr data scoped to whoever's asking (admin vs their own
  // requests only — see jellyseerr-scope.ts), so the cache can no longer be a single shared
  // entry for every viewer; keyed per-user.
  const viewerKey = session?.jfId ?? "anon";
  const [services, activity, torrents] = await Promise.all([
    withCacheSafe(`dashboard:services:${viewerKey}`, TTL.SHORT,      () => probeServices(session)),
    withCacheSafe(`dashboard:activity:${viewerKey}`, TTL.MEDIUM,     () => fetchActivity(session)),
    withCacheSafe("dashboard:torrents",      TTL.VERY_SHORT, fetchTorrents),
  ]);
  const disk = getDiskSection();

  return { services, activity, torrents, disk };
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  const payload = await buildDashboardPayload(session);
  return NextResponse.json(payload);
}
