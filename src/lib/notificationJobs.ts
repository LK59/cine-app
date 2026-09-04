import { availabilityNotifDb, pendingRequestDb, kvCacheDb, getDb } from "@/lib/db";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { logError } from "@/lib/logger";
import { sendPushToAll, sendPushToUser } from "@/lib/push";

/**
 * Où mène une notification.
 *
 * Elle envoyait vers `/radarr` ou `/sonarr` — c'est-à-dire dans l'outillage, avec ses profils de
 * qualité et ses boutons de recherche, pour quelqu'un à qui on annonce simplement qu'un film est
 * arrivé. Elle mène maintenant au lecteur, et directement sur la fiche du titre quand on a son
 * identifiant TMDB : la fiche sait dire « ouvrir » si le titre est là, et l'attente sinon.
 */
function playerUrl(mediaType: "movie" | "series", tmdbId?: number | null): string {
  if (!tmdbId) return "/player";
  return `/player#decouverte=${tmdbId}${mediaType === "series" ? "&type=series" : ""}`;
}


export async function checkWatchlistAvailability(): Promise<void> {
  try {
    const db = getDb();
    const items = db.prepare(
      "SELECT DISTINCT media_type, tmdb_id, title FROM watchlist WHERE status = 'to_watch'"
    ).all() as { media_type: string; tmdb_id: number; title: string }[];

    if (items.length === 0) return;

    const [movies, series] = await Promise.all([
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
    ]);

    const availableMovieTmdbIds = new Set(movies.filter((m) => m.hasFile && m.tmdbId).map((m) => m.tmdbId));
    const availableSeriesTmdbIds = new Set(
      series.filter((s) => s.tmdbId && (s.statistics?.episodeFileCount ?? 0) > 0).map((s) => s.tmdbId!)
    );

    for (const item of items) {
      const isAvailable =
        (item.media_type === "movie" && availableMovieTmdbIds.has(item.tmdb_id)) ||
        (item.media_type === "series" && availableSeriesTmdbIds.has(item.tmdb_id));

      if (!isAvailable) continue;
      if (availabilityNotifDb.hasBeenNotified(item.media_type, item.tmdb_id)) continue;

      await sendPushToAll({
        title: "🎬 Disponible maintenant",
        body: `${item.title} est disponible dans ta bibliothèque`,
        url: playerUrl(item.media_type === "movie" ? "movie" : "series", item.tmdb_id),
        tag: "watchlist-available",
        category: "watchlist-available",
      });

      availabilityNotifDb.markNotified(item.media_type, item.tmdb_id);
    }

    availabilityNotifDb.cleanup(30 * 24 * 3600_000);
  } catch (err) {
    logError("notifications.watchlist-availability", err);
  }
}

export async function checkNewEpisodes(): Promise<void> {
  try {
    const db = getDb();
    const cutoff = Date.now() - 2 * 3600_000;
    const recentImports = db.prepare(
      "SELECT id, tmdb_id, title, detail FROM timeline_events WHERE source = 'sonarr' AND event_type = 'import' AND event_date > ? AND tmdb_id IS NOT NULL"
    ).all(cutoff) as { id: number; tmdb_id: number; title: string; detail: string | null }[];

    for (const ev of recentImports) {
      if (!ev.tmdb_id) continue;
      // Dedup key is the timeline event's own row id, not the series' tmdb_id: several
      // episodes of the same show share one tmdb_id, and keying on that meant the first
      // "new episode" push for a series permanently suppressed every later episode of that
      // same series until the 30-day cleanup ran.
      if (availabilityNotifDb.hasBeenNotified("episode", ev.id)) continue;

      await sendPushToAll({
        title: "📺 Nouvel épisode",
        body: `${ev.title}${ev.detail ? ` — ${ev.detail}` : ""} est disponible`,
        url: "/player",
        tag: "new-episode",
        category: "new-episode",
      });

      availabilityNotifDb.markNotified("episode", ev.id);
    }
  } catch (err) {
    logError("notifications.new-episodes", err);
  }
}

// Notifies the specific person who made a Jellyseerr request through cine-app once it's actually
// available — distinct from checkWatchlistAvailability above, which blasts every subscriber for
// anything on ANYONE's "to_watch" watchlist. Reads only already-cached Radarr/Sonarr data (same
// as that check), never calls Jellyseerr itself: a background cron has no user session to
// authenticate with against this fork's session-gated API, and there's no need to — cine-app
// already recorded who requested what at request-creation time (see /api/jellyseerr/requests).
export async function checkRequestAvailability(): Promise<void> {
  try {
    const pending = pendingRequestDb.getAll();
    if (pending.length === 0) return;

    const [movies, series] = await Promise.all([
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
    ]);

    for (const req of pending) {
      let available = false;
      let title: string | null = null;

      if (req.mediaType === "movie") {
        const movie = movies.find((m) => m.tmdbId === req.tmdbId);
        title = movie?.title ?? null;
        available = !!movie?.hasFile;
      } else {
        const show = series.find((s) => s.tmdbId === req.tmdbId);
        title = show?.title ?? null;
        // Every specifically-requested season must be fully downloaded — a partial season
        // shouldn't count as "your request is ready", matching the season-aware request flow
        // this notification is meant to close the loop on.
        const seasonNumbers = req.seasons ?? show?.seasons?.map((s) => s.seasonNumber) ?? [];
        available =
          !!show &&
          seasonNumbers.length > 0 &&
          seasonNumbers.every((n) => {
            const season = show.seasons?.find((s) => s.seasonNumber === n);
            const stats = season?.statistics;
            return !!stats && stats.episodeCount > 0 && stats.episodeFileCount >= stats.episodeCount;
          });
      }

      if (!available || !title) continue;

      await sendPushToUser(req.userId, {
        title: "🎬 Ta demande est disponible",
        body: `${title} est maintenant disponible`,
        url: playerUrl(req.mediaType === "movie" ? "movie" : "series", req.tmdbId),
        tag: `request-available-${req.mediaType}-${req.tmdbId}`,
        category: "request-available",
      });
      pendingRequestDb.remove(req.id);
    }
  } catch (err) {
    logError("notifications.request-availability", err);
  }
}

// The disk-backed cache (TMDB credits/ratings, natural-search credit checks, ...) has no TTL-based
// eviction of its own — withPersistentCache only re-fetches past an entry's TTL, it never deletes
// the stale row. Without this, kv_cache grows forever (one row per movie/series/person ever looked
// up). 30 days comfortably outlives every TTL currently used against it (longest is 7 days).
function cleanupDiskCache(): void {
  try {
    kvCacheDb.cleanup(30 * 24 * 3600_000);
  } catch (err) {
    logError("notifications.kv-cache-cleanup", err);
  }
}

export function startNotificationCron(): void {
  const startupDelay = setTimeout(async () => {
    await checkWatchlistAvailability();
    await checkNewEpisodes();
    await checkRequestAvailability();
    cleanupDiskCache();
  }, 60_000);
  startupDelay.unref?.();

  const interval = setInterval(async () => {
    await checkWatchlistAvailability();
    await checkNewEpisodes();
    await checkRequestAvailability();
    cleanupDiskCache();
  }, 3600_000);
  interval.unref?.();
}
