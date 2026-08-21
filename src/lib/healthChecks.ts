import fs from "fs/promises";
import { config } from "@/lib/config";
import { jellyfin } from "@/lib/clients/jellyfin";
import { getDb } from "@/lib/db";
import { MEDIA_ROOT, MOVIES_PATH, TV_PATH, SEEDS_PATH, SEED_MOVIES_PATH, SEED_TV_PATH, CROSS_SEED_PATH } from "@/lib/media-paths";

export type CheckStatus = "ok" | "degraded" | "down";

export interface ServiceHealth {
  name: string;
  url: string;
  status: CheckStatus;
  latencyMs: number | null;
  version: string | null;
  error: string | null;
}

// ─── Individual service pings ──────────────────────────────────────────────────
// Shared by the technical /api/health route and the capability engine below, so there's one
// definition of "is Radarr up" instead of two that can quietly drift apart.

// Generic ping for services with X-Api-Key header
export async function pingWithKey(
  name: string,
  baseUrl: string,
  path: string,
  apiKey: string,
  versionKeys?: string[],
): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { "X-Api-Key": apiKey },
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name, url: baseUrl, status: "degraded", latencyMs, version: null, error: `HTTP ${res.status}` };
    let version: string | null = null;
    try {
      const json = await res.json();
      if (versionKeys) version = versionKeys.reduce((o: any, k) => o?.[k], json) ?? null;
    } catch {}
    return { name, url: baseUrl, status: "ok", latencyMs, version, error: null };
  } catch (e: any) {
    return { name, url: baseUrl, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

// Jellyfin — public endpoint, no key needed. Proves the box itself is reachable, independent of
// whether our own configured API key still works (see pingJellyfinApi below).
export async function pingJellyfin(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${config.jellyfin.url}/System/Info/Public`, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name: "Jellyfin", url: config.jellyfin.url, status: "degraded", latencyMs, version: null, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { name: "Jellyfin", url: config.jellyfin.url, status: "ok", latencyMs, version: json.Version ?? null, error: null };
  } catch (e: any) {
    return { name: "Jellyfin", url: config.jellyfin.url, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

// Jellyfin, but through our own authenticated client (same call the player/browsing code path
// depends on) — distinct from pingJellyfin: Jellyfin itself can be up while our configured API
// key is wrong/expired, which pingJellyfin alone would never catch.
export async function pingJellyfinApi(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const info = await jellyfin.getSystemInfo();
    return { name: "Jellyfin API", url: config.jellyfin.url, status: "ok", latencyMs: Date.now() - start, version: info.Version ?? null, error: null };
  } catch (e: any) {
    return { name: "Jellyfin API", url: config.jellyfin.url, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

// Jellyseerr — no API key on /api/v1/status
export async function pingJellyseerr(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${config.jellyseerr.url}/api/v1/status`, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name: "Jellyseerr", url: config.jellyseerr.url, status: "degraded", latencyMs, version: null, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { name: "Jellyseerr", url: config.jellyseerr.url, status: "ok", latencyMs, version: json.version ?? null, error: null };
  } catch (e: any) {
    return { name: "Jellyseerr", url: config.jellyseerr.url, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

// Simple reachability ping — any HTTP response = service is up
export async function pingReachable(name: string, url: string, path = "/"): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const res = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    });
    const latencyMs = Date.now() - start;
    // Any response (including 4xx) means the service is up and reachable
    return { name, url, status: "ok", latencyMs, version: null, error: null };
  } catch (e: any) {
    return { name, url, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

const TMDB_URL = "https://api.themoviedb.org";

export async function pingTmdb(): Promise<ServiceHealth> {
  const start = Date.now();
  const apiKey = config.tmdb.apiKey;
  if (!apiKey) return { name: "TMDB", url: TMDB_URL, status: "down", latencyMs: 0, version: null, error: "No API key configured" };
  try {
    const res = await fetch(`${TMDB_URL}/3/authentication?api_key=${apiKey}`, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name: "TMDB", url: TMDB_URL, status: "degraded", latencyMs, version: null, error: `HTTP ${res.status}` };
    return { name: "TMDB", url: TMDB_URL, status: "ok", latencyMs, version: null, error: null };
  } catch (e: any) {
    return { name: "TMDB", url: TMDB_URL, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

const MDBLIST_URL = "https://mdblist.com";
// Shawshank Redemption — a fixed, permanently-valid IMDb id used purely to exercise the mdblist
// API round-trip; the content returned is never used for anything.
const MDBLIST_PROBE_IMDB_ID = "tt0111161";

export async function pingMdblist(): Promise<ServiceHealth> {
  const start = Date.now();
  const apiKey = process.env.MDBLIST_API_KEY;
  if (!apiKey) return { name: "mdblist", url: MDBLIST_URL, status: "down", latencyMs: 0, version: null, error: "No API key configured" };
  try {
    const res = await fetch(`${MDBLIST_URL}/api/?apikey=${apiKey}&i=${MDBLIST_PROBE_IMDB_ID}`, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { name: "mdblist", url: MDBLIST_URL, status: "degraded", latencyMs, version: null, error: `HTTP ${res.status}` };
    return { name: "mdblist", url: MDBLIST_URL, status: "ok", latencyMs, version: null, error: null };
  } catch (e: any) {
    return { name: "mdblist", url: MDBLIST_URL, status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "Timeout" };
  }
}

// Not a network service — the watchlist lives in our own SQLite file, so "is it up" really means
// "can we open the DB and run a query", which is what this actually checks.
export async function pingWatchlistDb(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    getDb().prepare("SELECT 1").get();
    return { name: "Watchlist DB", url: "local", status: "ok", latencyMs: Date.now() - start, version: null, error: null };
  } catch (e: any) {
    return { name: "Watchlist DB", url: "local", status: "down", latencyMs: Date.now() - start, version: null, error: e?.message ?? "DB error" };
  }
}

// Also local/config-only — push notifications don't depend on a remote service being reachable,
// just on the VAPID keypair actually being configured (web-push signs requests locally).
export async function pingPushConfig(): Promise<ServiceHealth> {
  const configured = !!process.env.VAPID_PUBLIC_KEY && !!process.env.VAPID_PRIVATE_KEY;
  return {
    name: "Push config",
    url: "local",
    status: configured ? "ok" : "down",
    latencyMs: 0,
    version: null,
    error: configured ? null : "VAPID keys not configured",
  };
}

// ─── Storage path checks ────────────────────────────────────────────────────────
// Verifies the filesystem paths disk-stats.ts/storage-scan.ts read from are actually
// mounted and readable inside the container. Without this, a misconfigured MEDIA_ROOT
// (or a docker-compose volume that isn't mounted) silently shows up as "0 bytes" on the
// stats page instead of a clear error — this makes the misconfiguration visible.

export interface StoragePathHealth {
  name: string;
  path: string;
  status: CheckStatus;
  entries: number | null;
  error: string | null;
}

async function checkStoragePath(name: string, path: string, optional = false): Promise<StoragePathHealth> {
  try {
    const entries = await fs.readdir(path);
    return { name, path, status: "ok", entries: entries.length, error: null };
  } catch (e: any) {
    // Cross-seed-links is allowed to be absent (storage-scan.ts degrades gracefully) —
    // don't flag a missing optional dir as a misconfiguration.
    if (optional && e?.code === "ENOENT") {
      return { name, path, status: "ok", entries: null, error: null };
    }
    return { name, path, status: "down", entries: null, error: e?.code === "ENOENT" ? "notFound" : (e?.message ?? "notReadable") };
  }
}

export async function checkAllStoragePaths(): Promise<StoragePathHealth[]> {
  return Promise.all([
    checkStoragePath("mediaRoot", MEDIA_ROOT),
    checkStoragePath("movies", MOVIES_PATH),
    checkStoragePath("tv", TV_PATH),
    checkStoragePath("seeds", SEEDS_PATH),
    checkStoragePath("seedMovies", SEED_MOVIES_PATH),
    checkStoragePath("seedTv", SEED_TV_PATH),
    checkStoragePath("crossSeed", CROSS_SEED_PATH, true),
  ]);
}

export type ServiceKey =
  | "jellyfin" | "jellyfinApi" | "radarr" | "sonarr" | "jellyseerr" | "bazarr" | "jackett" | "qbittorrent" | "tmdb"
  | "mdblist" | "watchlistDb" | "pushConfig";

export async function runAllServiceChecks(): Promise<Record<ServiceKey, ServiceHealth>> {
  const [
    jellyfinR, jellyfinApiR, radarrR, sonarrR, jellyseerrR, bazarrR, jackettR, qbittorrentR, tmdbR,
    mdblistR, watchlistDbR, pushConfigR,
  ] = await Promise.all([
    pingJellyfin(),
    pingJellyfinApi(),
    pingWithKey("Radarr", config.radarr.url, "/api/v3/system/status", config.radarr.apiKey, ["version"]),
    pingWithKey("Sonarr", config.sonarr.url, "/api/v3/system/status", config.sonarr.apiKey, ["version"]),
    pingJellyseerr(),
    pingWithKey("Bazarr", config.bazarr.url, "/api/badges/episodes", config.bazarr.apiKey),
    pingReachable("Jackett", config.jackett.url, "/UI/Dashboard"),
    pingReachable("qBittorrent", config.qbittorrent.url, "/"),
    pingTmdb(),
    pingMdblist(),
    pingWatchlistDb(),
    pingPushConfig(),
  ]);
  return {
    jellyfin: jellyfinR,
    jellyfinApi: jellyfinApiR,
    radarr: radarrR,
    sonarr: sonarrR,
    jellyseerr: jellyseerrR,
    bazarr: bazarrR,
    jackett: jackettR,
    qbittorrent: qbittorrentR,
    tmdb: tmdbR,
    mdblist: mdblistR,
    watchlistDb: watchlistDbR,
    pushConfig: pushConfigR,
  };
}

// ─── Capability engine ──────────────────────────────────────────────────────────
// Translates "which technical service is up" into "what can someone actually do right now" —
// a capability is down the moment any hard dependency is down, degraded if a hard dependency is
// merely degraded, and also degraded (with an explanatory note) if a *soft* dependency is down —
// something that doesn't block the action but changes what happens next.

export interface CapabilityDef {
  id: string;
  requires: ServiceKey[];
  softRequires?: { service: ServiceKey; noteKey: string }[];
}

export const CAPABILITIES: CapabilityDef[] = [
  { id: "watchJellyfin", requires: ["jellyfin"] },
  { id: "watchCineApp", requires: ["jellyfinApi"] },
  { id: "auth", requires: ["jellyfin"] },
  { id: "movieLibrary", requires: ["radarr"] },
  { id: "seriesLibrary", requires: ["sonarr"] },
  { id: "subtitles", requires: ["bazarr"] },
  { id: "searchEngine", requires: ["jackett"] },
  { id: "requestMedia", requires: ["jellyseerr"] },
  { id: "download", requires: ["qbittorrent", "jackett"] },
  { id: "addMovies", requires: ["radarr", "jackett", "jellyseerr"], softRequires: [{ service: "qbittorrent", noteKey: "addMoviesNoDownload" }] },
  { id: "addSeries", requires: ["sonarr", "jackett", "jellyseerr"], softRequires: [{ service: "qbittorrent", noteKey: "addSeriesNoDownload" }] },
  { id: "discovery", requires: ["tmdb"] },
  { id: "calendar", requires: ["radarr", "sonarr"] },
  { id: "recommendations", requires: ["tmdb"] },
  { id: "libraryStats", requires: ["jellyfin", "radarr", "sonarr"] },
  { id: "liveSessions", requires: ["jellyfin"] },
  { id: "resumePlayback", requires: ["jellyfin"] },
  { id: "multiSourceRatings", requires: ["mdblist"] },
  { id: "actorPages", requires: ["tmdb"] },
  { id: "globalSearch", requires: ["tmdb", "radarr", "sonarr", "jellyfin"] },
  { id: "pushNotifications", requires: ["pushConfig"] },
  { id: "manualSubtitleSearch", requires: ["bazarr"] },
  { id: "watchlist", requires: ["watchlistDb"] },
  { id: "trailers", requires: ["tmdb"] },
  { id: "collections", requires: ["tmdb"] },
  { id: "similarMedia", requires: ["tmdb"] },
  { id: "externalReleaseDates", requires: ["tmdb"] },
  { id: "activeDownloads", requires: ["qbittorrent"] },
  { id: "importQueue", requires: ["radarr", "sonarr"] },
  { id: "indexerStatus", requires: ["jackett"] },
  { id: "videoPreviews", requires: ["jellyfin"] },
];

export interface CapabilityResult {
  id: string;
  status: CheckStatus;
  note: string | null;
  dependsOn: { service: ServiceKey; status: CheckStatus }[];
  softDependsOn: { service: ServiceKey; status: CheckStatus }[];
}

export function computeCapabilities(services: Record<ServiceKey, ServiceHealth>): CapabilityResult[] {
  return CAPABILITIES.map((cap) => {
    const dependsOn = cap.requires.map((service) => ({ service, status: services[service]?.status ?? "down" as CheckStatus }));
    const soft = (cap.softRequires ?? []).map((sr) => ({ ...sr, status: services[sr.service]?.status ?? "down" as CheckStatus }));

    let status: CheckStatus;
    let note: string | null = null;
    if (dependsOn.some((d) => d.status === "down")) {
      status = "down";
    } else if (dependsOn.some((d) => d.status === "degraded")) {
      status = "degraded";
    } else {
      const softBad = soft.find((d) => d.status !== "ok");
      if (softBad) {
        status = "degraded";
        note = softBad.noteKey;
      } else {
        status = "ok";
      }
    }

    return {
      id: cap.id,
      status,
      note,
      dependsOn,
      softDependsOn: soft.map(({ service, status }) => ({ service, status })),
    };
  });
}
