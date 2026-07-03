import { preload } from "swr";
import { fetcher } from "@/lib/swr";

// Warms the SWR cache for a route's main data before navigation actually
// happens (hover/focus on its nav link), so the page renders with data
// already in cache instead of waiting for a fresh round-trip on mount.
const PREFETCH_MAP: Record<string, string[]> = {
  "/": ["/api/status", "/api/activity"],
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
  for (const key of keys) preload(key, fetcher);
}

export function prefetchMovieDetail(id: number) {
  preload(`/api/radarr/movies/${id}`, fetcher);
  preload(`/api/radarr/movies/${id}/info`, fetcher);
  preload("/api/radarr/meta", fetcher);
}

export function prefetchSeriesDetail(id: number) {
  preload(`/api/sonarr/series/${id}`, fetcher);
  preload(`/api/sonarr/series/${id}/info`, fetcher);
  preload("/api/sonarr/meta", fetcher);
}
