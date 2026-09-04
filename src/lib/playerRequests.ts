import { jellyseerr, type JellyseerrRequest } from "@/lib/clients/jellyseerr";
import { cachedMovieInfo, cachedTvInfo, cachedMovies, cachedSeries } from "@/lib/server-cache";
import { resolveRequestState, isReleased, type PlayerRequestState } from "@/lib/playerRequestState";
import type { SessionPayload } from "@/lib/auth";

export interface PlayerRequest {
  /** L'identifiant de la demande chez Jellyseerr — ce qu'il faut pour l'annuler. */
  id: number;
  tmdbId: number | null;
  type: "movie" | "series";
  title: string;
  poster: string | null;
  year: number | null;
  state: PlayerRequestState;
  requestedAt: string;
  canCancel: boolean;
  /** Renseigné dès que le titre est arrivé : la carte devient alors cliquable. */
  libraryId: number | null;
}

/**
 * Les demandes de la personne connectée, dites dans ses mots.
 *
 * Trois sources se rejoignent ici, et c'est le seul endroit où elles ont le droit de se croiser :
 * Jellyseerr pour la demande et son avancement, son endpoint média pour le titre, l'affiche et
 * la date de sortie (que `/api/v1/request` ne renvoie pas — vérifié en direct), et la
 * bibliothèque pour savoir si une demande arrivée est devenue une fiche qu'on peut ouvrir.
 *
 * Rien n'est recopié en base : Jellyseerr est le registre des demandes, on le lit. Une demande
 * approuvée ailleurs, refusée à la main ou supprimée depuis son interface se reflète ici à la
 * requête suivante, sans synchronisation à écrire ni à débuguer.
 */
export async function getPlayerRequests(session: SessionPayload): Promise<PlayerRequest[]> {
  const ownId = await resolveOwnJellyseerrId(session);
  if (ownId == null) return [];

  const data = await jellyseerr.getRequestsByUser(ownId, session.jsCookie).catch(() => ({ results: [] }));
  return decorate(data.results);
}

async function resolveOwnJellyseerrId(session: SessionPayload): Promise<number | null> {
  if (session.jsCookie) {
    const me = await jellyseerr.getMe(session.jsCookie).catch(() => null);
    if (me?.id) return me.id;
  }
  if (!session.jfUser) return null;
  // Repli sans cookie de session (connexion admin locale, ou la connexion Jellyseerr de
  // l'ouverture de session a échoué) : la liste des comptes, via la clé maîtresse.
  const users = await jellyseerr.getUsers().catch(() => ({ results: [] }));
  return users.results.find((u) => u.jellyfinUsername?.toLowerCase() === session.jfUser!.toLowerCase())?.id ?? null;
}

async function decorate(requests: JellyseerrRequest[]): Promise<PlayerRequest[]> {
  // Un appel par titre distinct, pas un par demande : la même série peut apparaître plusieurs
  // fois (une demande par saison), et ces appels passent par le cache serveur de toute façon.
  const movieIds = new Set<number>();
  const tvIds = new Set<number>();
  for (const r of requests) {
    const tmdbId = r.media?.tmdbId;
    if (!tmdbId) continue;
    if ((r.media?.mediaType || r.type) === "movie") movieIds.add(tmdbId);
    else tvIds.add(tmdbId);
  }

  const [movieInfos, tvInfos, movies, series] = await Promise.all([
    Promise.allSettled([...movieIds].map((id) => cachedMovieInfo(id).then((d) => [id, d] as const))),
    Promise.allSettled([...tvIds].map((id) => cachedTvInfo(id).then((d) => [id, d] as const))),
    cachedMovies().catch(() => []),
    cachedSeries().catch(() => []),
  ]);

  const movieInfo = new Map(movieInfos.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
  const tvInfo = new Map(tvInfos.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
  const movieLibrary = new Map(movies.map((m) => [m.tmdbId, m.id]));
  const seriesLibrary = new Map(series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s.id]));

  return requests.map((r): PlayerRequest => {
    const tmdbId = r.media?.tmdbId ?? null;
    const type: "movie" | "series" = (r.media?.mediaType || r.type) === "movie" ? "movie" : "series";
    const info = tmdbId ? (type === "movie" ? movieInfo.get(tmdbId) : tvInfo.get(tmdbId)) : undefined;

    const date =
      info && "releaseDate" in info ? info.releaseDate : info && "firstAirDate" in info ? info.firstAirDate : undefined;
    // `undefined` = l'appel n'a pas abouti, donc on ne sait pas et on ne prétend rien.
    const released = info === undefined ? null : isReleased(date);

    const title =
      (info && ("title" in info ? info.title : "name" in info ? info.name : undefined)) || r.media?.title || "";

    return {
      id: r.id,
      tmdbId,
      type,
      title,
      poster: info?.posterPath ? `https://image.tmdb.org/t/p/w342${info.posterPath}` : null,
      year: date ? Number.parseInt(String(date).slice(0, 4), 10) || null : null,
      state: resolveRequestState({
        requestStatus: r.status,
        mediaStatus: r.media?.status ?? info?.mediaInfo?.status ?? null,
        released,
      }),
      requestedAt: r.createdAt,
      // Jellyseerr dit lui-même si le compte a le droit de retirer la demande ; par défaut on
      // suppose que oui, c'est la sienne. L'annulation ne touche jamais à Radarr — voir
      // `deleteRequest` dans le client.
      canCancel: r.canRemove !== false,
      libraryId: tmdbId ? (type === "movie" ? movieLibrary.get(tmdbId) : seriesLibrary.get(tmdbId)) ?? null : null,
    };
  });
}
