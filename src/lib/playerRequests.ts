import { jellyseerr, type JellyseerrRequest } from "@/lib/clients/jellyseerr";
import { cachedMovieInfo, cachedTvInfo } from "@/lib/server-cache";
import { playableLibrary, playableId } from "@/lib/playerLibrary";
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
  /** Date du dernier changement d'état : pour une demande aboutie, c'est celle de l'arrivée. */
  changedAt: string;
  /**
   * Arrivée dans les sept derniers jours.
   *
   * Calculé ici, une fois, plutôt que dans le rendu : d'une part `Date.now()` pendant un rendu
   * React donne un résultat qui change d'une image à l'autre (le compilateur le refuse à juste
   * titre), d'autre part c'est le genre de règle qui doit avoir un seul auteur.
   */
  justArrived: boolean;
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

/** Sept jours : au-delà, un titre arrivé n'est plus une nouvelle, c'est la bibliothèque. */
const ARRIVED_WINDOW_MS = 7 * 24 * 3600_000;

async function decorate(requests: JellyseerrRequest[]): Promise<PlayerRequest[]> {
  const now = Date.now();
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

  const [movieInfos, tvInfos, lib] = await Promise.all([
    Promise.allSettled([...movieIds].map((id) => cachedMovieInfo(id).then((d) => [id, d] as const))),
    Promise.allSettled([...tvIds].map((id) => cachedTvInfo(id).then((d) => [id, d] as const))),
    playableLibrary(),
  ]);

  const movieInfo = new Map(movieInfos.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
  const tvInfo = new Map(tvInfos.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));

  const decorated = requests.map((r): PlayerRequest => {
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
      changedAt: r.updatedAt || r.createdAt,
      justArrived: false, // recalculé juste après, une fois l'état connu

      // Jellyseerr dit lui-même si le compte a le droit de retirer la demande ; par défaut on
      // suppose que oui, c'est la sienne. L'annulation ne touche jamais à Radarr — voir
      // `deleteRequest` dans le client.
      canCancel: r.canRemove !== false,
      // « Disponible » veut dire ouvrable : une demande que Jellyseerr croit terminée mais dont
      // le fichier n'est pas là garde `libraryId: null` et retombe sur la fiche TMDB.
      libraryId: playableId(lib, type, tmdbId),
    };
  }).map((r) => ({
    ...r,
    justArrived: r.state === "available" && now - Date.parse(r.changedAt) < ARRIVED_WINDOW_MS,
  }));

  // Ce qu'on attend d'abord, ce qui est arrivé ensuite.
  //
  // Jellyseerr les rend dans l'ordre des identifiants, et comme presque tout finit par aboutir,
  // les cinq demandes en cours se retrouvaient noyées au milieu de quarante titres déjà là. Or
  // c'est exactement l'inverse qu'on vient voir : « où en sont mes demandes ». À l'intérieur de
  // chaque groupe, le plus récemment bougé en premier.
  const RANK: Record<PlayerRequestState, number> = { processing: 0, unreleased: 1, failed: 2, available: 3 };
  return decorated.sort((a, b) => {
    if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] - RANK[b.state];
    return Date.parse(b.changedAt) - Date.parse(a.changedAt);
  });
}
