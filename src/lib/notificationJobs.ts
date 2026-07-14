import { pushDb, availabilityNotifDb, getDb } from "@/lib/db";
import { sendWebPush, shouldRemovePushSubscription } from "@/lib/webPush";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { logError } from "@/lib/logger";

async function sendToAll(payload: unknown): Promise<void> {
  const subs = pushDb.getAll();
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      } catch (err) {
        if (shouldRemovePushSubscription(err)) {
          pushDb.remove(sub.endpoint);
        }
      }
    })
  );
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

      await sendToAll({
        title: "🎬 Disponible maintenant",
        body: `${item.title} est disponible dans ta bibliothèque`,
        url: item.media_type === "movie" ? "/radarr" : "/sonarr",
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
      "SELECT DISTINCT tmdb_id, title, detail FROM timeline_events WHERE source = 'sonarr' AND event_type = 'import' AND event_date > ? AND tmdb_id IS NOT NULL"
    ).all(cutoff) as { tmdb_id: number; title: string; detail: string | null }[];

    for (const ev of recentImports) {
      if (!ev.tmdb_id) continue;
      if (availabilityNotifDb.hasBeenNotified("episode", ev.tmdb_id)) continue;

      await sendToAll({
        title: "📺 Nouvel épisode",
        body: `${ev.title}${ev.detail ? ` — ${ev.detail}` : ""} est disponible`,
        url: "/sonarr",
      });

      availabilityNotifDb.markNotified("episode", ev.tmdb_id);
    }
  } catch (err) {
    logError("notifications.new-episodes", err);
  }
}

export function startNotificationCron(): void {
  const startupDelay = setTimeout(async () => {
    await checkWatchlistAvailability();
    await checkNewEpisodes();
  }, 60_000);
  startupDelay.unref?.();

  const interval = setInterval(async () => {
    await checkWatchlistAvailability();
    await checkNewEpisodes();
  }, 3600_000);
  interval.unref?.();
}
