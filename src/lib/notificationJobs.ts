import { availabilityNotifDb, pendingRequestDb, kvCacheDb, getDb } from "@/lib/db";
import { cachedMovies, cachedSeries, cachedJellyfinSeriesAdmin, findJellyfinSeriesByTvdb } from "@/lib/server-cache";
import { jellyfin } from "@/lib/clients/jellyfin";
import { sonarr } from "@/lib/clients/sonarr";
import { logError } from "@/lib/logger";
import { sendPushToUser } from "@/lib/push";

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
    // Qui a rangé quoi : la liste est à chacun, l'annonce aussi.
    const rows = db.prepare(
      "SELECT user_id, media_type, tmdb_id, title, created_at FROM watchlist WHERE status = 'to_watch'"
    ).all() as { user_id: string; media_type: string; tmdb_id: number; title: string; created_at: number }[];

    if (rows.length === 0) return;

    const [movies, series, users] = await Promise.all([
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
      jellyfin.getUsers().catch(() => [] as { Id: string; Name: string }[]),
    ]);

    /**
     * Quand chaque titre est *arrivé* — et pas seulement s'il est là.
     *
     * « Disponible maintenant » annonçait tout titre de la liste qui avait un fichier, y compris
     * ceux qui l'avaient déjà quand on les a rangés : 27 films sur 33 ici (mesuré le 21/09/2026),
     * autant d'annonces qui n'annonçaient rien. On compare donc la date d'arrivée à celle de
     * l'ajout : le fichier du film chez Radarr, l'entrée de la série chez Sonarr. Sans date, on se
     * tait — une annonce manquée vaut mieux qu'une fausse.
     */
    const arrivedMovie = new Map<number, number>();
    for (const m of movies) {
      const at = m.hasFile && m.tmdbId ? Date.parse(m.movieFile?.dateAdded ?? "") : NaN;
      if (Number.isFinite(at)) arrivedMovie.set(m.tmdbId, at);
    }
    const arrivedSeries = new Map<number, number>();
    for (const sh of series) {
      const at = sh.tmdbId && (sh.statistics?.episodeFileCount ?? 0) > 0 ? Date.parse(sh.added ?? "") : NaN;
      if (Number.isFinite(at)) arrivedSeries.set(sh.tmdbId!, at);
    }
    // La liste range un compte sous son identifiant Jellyfin, les abonnements sous son nom : le
    // passage de l'un à l'autre est ici. Un identifiant inconnu de Jellyfin (le compte local) est
    // déjà un nom.
    const nameOf = new Map(users.map((u) => [u.Id, u.Name]));

    for (const row of rows) {
      const arrivedAt = (row.media_type === "movie" ? arrivedMovie : arrivedSeries).get(row.tmdb_id);
      if (arrivedAt === undefined || arrivedAt <= row.created_at) continue;

      const userName = nameOf.get(row.user_id) ?? row.user_id;
      /**
       * Une fois par personne, et plus une fois pour tout le monde.
       *
       * L'annonce partait à **tous** les abonnés — « X est disponible dans ta bibliothèque » pour
       * un titre de n'importe quelle liste — et la première la faisait taire pour les suivants.
       * La clé globale d'avant (`movie` / `series`) compte encore comme « déjà dit » : sans elle,
       * les titres déjà annoncés le seraient une seconde fois après ce changement.
       */
      const key = `watchlist:${userName}:${row.media_type}`;
      if (availabilityNotifDb.hasBeenNotified(key, row.tmdb_id)) continue;
      if (availabilityNotifDb.hasBeenNotified(row.media_type, row.tmdb_id)) continue;

      await sendPushToUser(userName, {
        title: "🎬 Disponible maintenant",
        body: `${row.title} est disponible dans ta bibliothèque`,
        url: playerUrl(row.media_type === "movie" ? "movie" : "series", row.tmdb_id),
        tag: "watchlist-available",
        category: "watchlist-available",
      });

      availabilityNotifDb.markNotified(key, row.tmdb_id);
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
/**
 * Les épisodes importés depuis `since`, lus dans l'historique de Sonarr — la source de la page
 * Timeline.
 *
 * Ce job lisait la table `timeline_events`, que rien n'a jamais remplie en production (0 ligne au
 * 21/09/2026 ; seuls les tests y écrivaient). La notification « Nouvel épisode » n'est donc jamais
 * partie, sans une erreur nulle part : une requête sur une table vide réussit toujours.
 *
 * L'identifiant de l'enregistrement Sonarr sert de clé de dédoublonnage : il est unique et stable.
 * Cent entrées couvrent largement deux heures — l'historique mêle recherches, imports et
 * suppressions, mais pas à ce rythme ici.
 */
export async function recentEpisodeImports(
  since: number
): Promise<{ id: number; tmdb_id: number; title: string; detail: string | null }[]> {
  const history = await sonarr.getHistory(100);
  const imports: { id: number; tmdb_id: number; title: string; detail: string | null }[] = [];
  for (const record of history.records ?? []) {
    if (record?.eventType !== "downloadFolderImported") continue;
    const at = Date.parse(record.date);
    if (!Number.isFinite(at) || at <= since) continue;
    const tmdbId = record.series?.tmdbId;
    if (typeof record.id !== "number" || typeof tmdbId !== "number" || !tmdbId) continue;
    const episode = record.episode;
    imports.push({
      id: record.id,
      tmdb_id: tmdbId,
      title: record.series?.title ?? record.sourceTitle ?? "",
      detail: episode
        ? `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`
        : null,
    });
  }
  return imports;
}

export async function checkNewEpisodes(): Promise<void> {
  try {
    const recentImports = await recentEpisodeImports(Date.now() - 2 * 3600_000);
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
/**
 * Une série demandée est-elle là ?
 *
 * Demandée en entier (`seasons` nul), elle exigeait que **toutes** ses saisons soient complètes —
 * saison 0 comprise, et saisons annoncées pas encore diffusées comprises. Or la saison des bonus
 * n'a presque jamais d'épisode suivi : 74 séries sur 137 ici (mesuré le 21/09/2026). Pour ces
 * séries, « Ta demande est disponible » ne serait jamais parti.
 *
 * Une demande entière compte donc les vraies saisons qui ont déjà des épisodes à avoir ; une
 * demande de saisons précises compte celles-là, et rien d'autre.
 */
export function isRequestedSeriesAvailable(
  show: { seasons?: { seasonNumber: number; statistics?: { episodeCount: number; episodeFileCount: number } }[] },
  requested: number[] | null
): boolean {
  const seasons = (show.seasons ?? []).filter((season) =>
    requested ? requested.includes(season.seasonNumber) : season.seasonNumber > 0 && (season.statistics?.episodeCount ?? 0) > 0
  );
  if (seasons.length === 0) return false;
  return seasons.every((season) => {
    const stats = season.statistics;
    return !!stats && stats.episodeCount > 0 && stats.episodeFileCount >= stats.episodeCount;
  });
}

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
        available = !!show && isRequestedSeriesAvailable(show, req.seasons);
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
