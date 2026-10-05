import { cachedJellyfinMoviesAdmin, cachedJellyfinSeriesAdmin, cachedMovies, cachedSeries, findJellyfinMovieByTmdb, findJellyfinSeriesByTvdb } from "@/lib/server-cache";
import type { RadarrMovie } from "@/lib/clients/radarr";
import type { SonarrSeries } from "@/lib/clients/sonarr";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

/**
 * Ce que le cinéma montre — une seule définition (DECISIONS.md §47).
 *
 * Un film avec son fichier, une série avec au moins un épisode, **et** son élément Jellyfin
 * retrouvé (dossier d'abord, puis identifiants, puis titre). C'était écrit dans les deux routes du
 * catalogue, et approché ailleurs — la recherche, les rangées TMDB, les personnes — par la seule
 * première moitié : un titre que Radarr ou Sonarr avait mais que Jellyfin ne rapprochait pas y
 * était « dans la bibliothèque », et l'ouvrir ne faisait rien, puisque le catalogue ne l'avait pas
 * (*The Arena*, 05/10/2026).
 */
export function matchMovies(movies: RadarrMovie[], jellyfin: JellyfinItem[]) {
  return movies
    .filter((m) => m.hasFile)
    .map((m) => ({ m, jfItem: findJellyfinMovieByTmdb(jellyfin, m.tmdbId, m.title, m.year, m.imdbId ?? null, m.path ?? null) }))
    .filter((x): x is { m: RadarrMovie; jfItem: JellyfinItem } => x.jfItem !== null);
}

export function matchSeries(series: SonarrSeries[], jellyfin: JellyfinItem[]) {
  return series
    .filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0)
    .map((s) => ({ s, jfItem: findJellyfinSeriesByTvdb(jellyfin, s.tvdbId, s.title, s.year, s.path ?? null) }))
    .filter((x): x is { s: SonarrSeries; jfItem: JellyfinItem } => x.jfItem !== null);
}

export interface CatalogueMembers {
  movies: RadarrMovie[];
  series: SonarrSeries[];
}

/**
 * Les titres du catalogue, tels que ses routes les servent. Si Jellyfin ne répond pas, la première
 * moitié de la règle seule (fichier, épisode) : mieux vaut un titre qui ne s'ouvre pas qu'une
 * bibliothèque qui disparaît des recherches le temps d'une panne.
 */
export async function catalogueMembers(): Promise<CatalogueMembers> {
  const [movies, series] = await Promise.all([
    cachedMovies().catch(() => [] as RadarrMovie[]),
    cachedSeries().catch(() => [] as SonarrSeries[]),
  ]);
  // Rattrapé quelle que soit la façon d'échouer — une promesse rejetée comme une erreur levée tout de
  // suite : Jellyfin absent ne doit jamais vider la bibliothèque des recherches.
  const attempt = <T,>(load: () => Promise<T>) => Promise.resolve().then(load).catch(() => null);
  const [jfMovies, jfSeries] = await Promise.all([
    attempt(() => cachedJellyfinMoviesAdmin()),
    attempt(() => cachedJellyfinSeriesAdmin()),
  ]);
  return {
    movies: jfMovies ? matchMovies(movies, jfMovies).map((x) => x.m) : movies.filter((m) => m.hasFile),
    series: jfSeries ? matchSeries(series, jfSeries).map((x) => x.s) : series.filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0),
  };
}
