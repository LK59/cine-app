import { availabilityNotifDb, pendingRequestDb, kvCacheDb, getDb } from "@/lib/db";
import { cachedMovies, cachedSeries, cachedJellyfinSeriesAdmin, findJellyfinSeriesByTvdb } from "@/lib/server-cache";
import { jellyfin } from "@/lib/clients/jellyfin";
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
  // La racine : le lecteur est l'application, et c'est là qu'une notification doit ouvrir.
  if (!tmdbId) return "/";
  return `/#decouverte=${tmdbId}${mediaType === "series" ? "&type=series" : ""}`;
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

/**
 * Prévenir d'un nouvel épisode — mais seulement ceux qui l'attendaient.
 *
 * Cette tâche poussait vers *tout le monde* à chaque épisode importé. Sur une bibliothèque active,
 * ça fait plusieurs notifications par jour pour des séries que la plupart des gens ne regardent
 * pas — et une notification qu'on n'attendait pas est une notification qu'on finit par couper,
 * emportant avec elle celles qui comptaient.
 *
 * « Attendre un épisode » a une définition exacte et déjà calculée par Jellyfin : la liste
 * « À suivre » d'un compte contient les séries qu'il a commencées et dont un épisode non vu
 * existe. Un épisode qui arrive sur une série qu'on n'a jamais lancée n'y apparaît pas ; celui qui
 * arrive sur une série finie y apparaît le jour où il arrive. C'est exactement la question posée.
 *
 * Le dédoublonnage devient donc par personne : le même épisode peut légitimement être annoncé à
 * trois comptes, et à chacun une seule fois.
 */
export async function checkNewEpisodes(): Promise<void> {
  try {
    const db = getDb();
    const cutoff = Date.now() - 2 * 3600_000;
    const recentImports = db.prepare(
      "SELECT id, tmdb_id, title, detail FROM timeline_events WHERE source = 'sonarr' AND event_type = 'import' AND event_date > ? AND tmdb_id IS NOT NULL"
    ).all(cutoff) as { id: number; tmdb_id: number; title: string; detail: string | null }[];
    if (recentImports.length === 0) return;

    const [sonarrSeries, jellyfinSeries, users] = await Promise.all([
      cachedSeries().catch(() => []),
      cachedJellyfinSeriesAdmin().catch(() => []),
      jellyfin.getUsers().catch(() => [] as { Id: string; Name: string }[]),
    ]);

    // L'événement porte le TMDB de la série ; Jellyfin la connaît par son TVDB. Le passage se
    // fait par Sonarr, qui a les deux — c'est le même appariement que le reste de l'application.
    const jellyfinSeriesId = (tmdbId: number): string | null => {
      const show = sonarrSeries.find((serie) => serie.tmdbId === tmdbId);
      if (!show) return null;
      return findJellyfinSeriesByTvdb(jellyfinSeries, show.tvdbId, show.title, show.year)?.Id ?? null;
    };

    // Une seule interrogation par compte, quel que soit le nombre d'épisodes importés.
    const following = new Map<string, Set<string>>();
    for (const user of users) {
      const nextUp = await jellyfin.getNextUpGlobal(user.Id, 50).catch(() => []);
      following.set(user.Name, new Set(nextUp.map((item) => item.SeriesId).filter((id): id is string => !!id)));
    }

    for (const ev of recentImports) {
      const seriesId = jellyfinSeriesId(ev.tmdb_id);
      if (!seriesId) continue;

      for (const [userName, followed] of following) {
        if (!followed.has(seriesId)) continue;
        // La clé porte le nom du compte : le même épisode s'annonce à plusieurs personnes, et une
        // seule fois à chacune. Sans ça, le premier averti faisait taire tous les autres.
        if (availabilityNotifDb.hasBeenNotified(`episode:${userName}`, ev.id)) continue;

        await sendPushToUser(userName, {
          title: "📺 Nouvel épisode",
          body: `${ev.title}${ev.detail ? ` — ${ev.detail}` : ""} est disponible`,
          url: "/",
          tag: "new-episode",
          category: "new-episode",
        });

        availabilityNotifDb.markNotified(`episode:${userName}`, ev.id);
      }
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
