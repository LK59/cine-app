import { preload } from "swr";
import { fetcher } from "@/lib/swr";

/**
 * Un préchargement SWR dont l'échec ne va nulle part — le seul `preload` du dépôt.
 *
 * `preload` rend la promesse de la requête, et personne ne l'attend : sans `.catch`, un réseau
 * absent devient un rejet non rattrapé. C'est ce que journalisait l'iPhone de Louis le 21/09/2026,
 * « Load failed » sur `/`, à chaque réouverture de l'application juste après un déploiement :
 * « Ma liste » était préchargée au démarrage alors que le réseau n'était pas encore revenu. Ce
 * n'est qu'une avance prise ; l'écran qui a vraiment besoin des données refera la demande.
 */
export function preloadQuietly<T>(key: string, fetch: (key: string) => Promise<T> = fetcher as (key: string) => Promise<T>): Promise<T | undefined> {
  try {
    return Promise.resolve(preload(key, fetch)).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

// Warms the SWR cache for a route's main data before navigation actually
// happens (hover/focus on its nav link), so the page renders with data
// already in cache instead of waiting for a fresh round-trip on mount.
const PREFETCH_MAP: Record<string, string[]> = {
  // The dashboard fetches a single consolidated payload (see DashboardClient.tsx) — this used
  // to point at /api/status + /api/activity from before that consolidation, which the dashboard
  // hasn't called since. Hovering "Accueil" was warming a cache entry the page never reads.
  "/": ["/api/dashboard"],
  // La même charge utile : `/gestion` est l'adresse définitive du tableau de bord, et c'est par
  // elle qu'on y arrive depuis le rail du lecteur.
  "/gestion": ["/api/dashboard"],
  "/radarr": ["/api/radarr/movies"],
  "/sonarr": ["/api/sonarr/series"],
  "/qbittorrent": ["/api/qbittorrent/torrents", "/api/qbittorrent/transfer"],
  "/bazarr": ["/api/bazarr/wanted"],
  "/jackett": ["/api/jackett/indexers"],
  "/jellyfin": ["/api/jellyfin/sessions", "/api/jellyfin/library"],
  "/jellyseerr": ["/api/jellyseerr/requests?filter=pending"],
};

export function prefetchRoute(href: string) {
  const keys = PREFETCH_MAP[href];
  if (!keys) return;
  for (const key of keys) void preloadQuietly(key);
}

export function prefetchMovieDetail(id: number) {
  void preloadQuietly(`/api/radarr/movies/${id}`);
  void preloadQuietly(`/api/radarr/movies/${id}/info`);
  void preloadQuietly("/api/radarr/meta");
}

export function prefetchSeriesDetail(id: number) {
  void preloadQuietly(`/api/sonarr/series/${id}`);
  void preloadQuietly(`/api/sonarr/series/${id}/info`);
  void preloadQuietly("/api/sonarr/meta");
}
