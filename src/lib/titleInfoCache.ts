// Ce que les descriptions de fiche (`/api/radarr/movies/<id>/info`, `/api/sonarr/series/<id>/info`)
// demandent en amont, mis en cache (08/10/2026).
//
// Chaque ouverture — ou chaque préchargement au survol — faisait six appels : l'élément Radarr ou
// Sonarr, les détails TMDB, ses vidéos, Bazarr, la file entière de Radarr/Sonarr et OMDb. Jusqu'à
// trente-sept par minute depuis un seul téléphone, et environ cent quatre-vingts appels OMDb par jour
// sur une clé qui en permet mille. Les parties stables sont gardées ; Bazarr et l'élément lui-même
// restent lus à chaque fois (sous-titres, fichier, suivi : ce qu'une fiche doit dire à jour).

import type { NextRequest } from "next/server";
import { omdb } from "@/lib/clients/omdb";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import type { createTmdbClient } from "@/lib/clients/tmdb";
import { withCache, withPersistentCache, TTL } from "@/lib/server-cache";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { hiddenTmdbKeysFor } from "@/lib/blockedTags";

type Tmdb = ReturnType<typeof createTmdbClient>;

/** Les détails TMDB changent rarement : dix minutes, par langue. */
const TMDB_INFO_TTL_MS = 10 * 60_000;
const WEEK_MS = 7 * 24 * 3600_000;

/**
 * Les détails et les vidéos d'un film. Un échec des détails n'est pas gardé (il traverse) ; des
 * vidéos introuvables valent une liste vide.
 */
export function cachedTmdbMovieInfo(tmdb: Tmdb, lang: string, tmdbId: number) {
  return withCache(`info:tmdb:movie:${tmdbId}:${lang}`, TMDB_INFO_TTL_MS, async () => {
    const [details, videos] = await Promise.all([tmdb.getMovie(tmdbId), tmdb.getMovieVideos(tmdbId).catch(() => ({ results: [] }))]);
    return { details, videos };
  });
}

export function cachedTmdbTvInfo(tmdb: Tmdb, lang: string, tmdbTvId: number) {
  return withCache(`info:tmdb:tv:${tmdbTvId}:${lang}`, TMDB_INFO_TTL_MS, async () => {
    const [details, videos] = await Promise.all([tmdb.getTv(tmdbTvId), tmdb.getTvVideos(tmdbTvId).catch(() => ({ results: [] }))]);
    return { details, videos };
  });
}

/** L'identifiant TMDB d'une série d'après son identifiant TVDB : une correspondance qui ne change pas. */
export function cachedTmdbIdForTvdb(tmdb: Tmdb, tvdbId: number): Promise<number | null> {
  return withPersistentCache(`tmdb:tvdb-id:${tvdbId}`, 4 * WEEK_MS, async () => (await tmdb.findTvByTvdbId(tvdbId)).tv_results[0]?.id ?? null);
}

/**
 * La note et les votes IMDb d'OMDb, une semaine — la même durée que `imdb-rating.ts`, qui ne garde
 * que la note : la fiche de gestion montre aussi les votes. Seuls les trois champs lus sont rangés.
 */
export function cachedOmdbRating(imdbId: string): Promise<{ Response: string; imdbRating: string; imdbVotes: string } | null> {
  if (!omdb.isEnabled()) return Promise.resolve(null);
  return withPersistentCache(`omdb:rating:raw:${imdbId}`, WEEK_MS, async () => {
    const r = await omdb.getRating(imdbId);
    return { Response: r.Response, imdbRating: r.imdbRating, imdbVotes: r.imdbVotes };
  });
}

/** Les files de Radarr et Sonarr, sous les clés que `downloadProgress.ts` partage déjà. */
export const cachedRadarrQueue = () => withCache("radarr:queue", TTL.VERY_SHORT, () => radarr.getQueue());
export const cachedSonarrQueue = () => withCache("sonarr:queue", TTL.VERY_SHORT, () => sonarr.getQueue());

/**
 * Le titre est-il caché à la personne qui demande, par les tags bloqués de son compte
 * (DECISIONS.md §54) ? La description d'une fiche le livrait en entier — synopsis, distribution,
 * bande-annonce — à qui le demandait par son identifiant. L'administrateur voit tout.
 */
export async function hiddenFromCaller(req: NextRequest, key: string): Promise<boolean> {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.role === "admin") return false;
  return (await hiddenTmdbKeysFor(session.jfId)).has(key);
}

/**
 * La personne qui demande est-elle l'administrateur — la seule à qui la description d'une fiche
 * porte ce que la gestion affiche (chasse de nuit du 18/11/2026) ?
 *
 * Les mêmes routes `/info` servent la fiche du cinéma et la page de gestion d'un titre. La seconde
 * lit les sous-titres de Bazarr — pour une série, chaque épisode avec **son chemin sur le disque** et
 * le **nom de sa sortie** (`sceneName`) — et les téléchargements en cours (nom du torrent, indexeur) ;
 * le cinéma n'en lit rien (`tmdb`, `trailerKey`, `imdbId`). Tout compte les recevait pourtant, alors
 * que la règle est qu'un compte ordinaire n'accède à aucune donnée de la gestion (`ADMIN_ONLY_READS`,
 * 15/10/2026) — et les attendait : 96 Ko et 360 à 410 ms pour une série de 108 épisodes, contre 2 Ko
 * utiles, la fiche affichant son synopsis d'autant plus tard.
 */
export async function callerManages(req: NextRequest): Promise<boolean> {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  return session?.role === "admin";
}
