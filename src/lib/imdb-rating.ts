import { tmdb } from "@/lib/clients/tmdb";
import { omdb } from "@/lib/clients/omdb";
import { withPersistentCache } from "@/lib/server-cache";

// Resolves TMDB id → IMDb rating string (e.g. "7.4"), cached 24h. Shared by the watchlist
// ratings route and the dashboard's "recently added series" row — Sonarr's own `ratings` field
// (unlike Radarr's) isn't IMDb-specific, so series need this TMDB→imdb_id→OMDb resolution;
// movies read Radarr's own ratings.imdb.value directly instead, which needs no external call.
/**
 * Resolves a rating from a TVDB id, which is the only id Sonarr actually has.
 *
 * Sonarr is built on TVDB: its `tmdbId` field exists and, on this instance, is null for all one
 * hundred and thirty-one series — so the badge on the series page had a component, a route and a
 * cache behind it and simply never had an id to ask about. One extra hop through TMDB's `find`
 * turns the id Sonarr does have into the one everything else here speaks.
 */
export async function getImdbRatingByTvdb(tvdbId: number): Promise<string | null> {
  if (!omdb.isEnabled()) return null;
  return withPersistentCache(`imdb:rating:tvdb:${tvdbId}`, 24 * 3600_000, async () => {
    const found = await tmdb.findTvByTvdbId(tvdbId);
    const tmdbId = found.tv_results[0]?.id;
    if (!tmdbId) return null;
    return getImdbRating(tmdbId, "series");
  }).catch(() => null);
}

export async function getImdbRating(tmdbId: number, mediaType: "movie" | "series"): Promise<string | null> {
  if (!omdb.isEnabled()) return null;
  // The fallback lives outside withCache: a transient TMDB/OMDb failure must not get cached as
  // "no rating" for 24h — better to just retry next time. A genuine "no IMDb id"/"no rating"
  // result is a real `null` returned normally below, so it still caches correctly.
  return withPersistentCache(`imdb:rating:${mediaType}:${tmdbId}`, 24 * 3600_000, async () => {
    let imdbId: string | null = null;

    if (mediaType === "movie") {
      const movie = await tmdb.getMovie(tmdbId);
      imdbId = movie.imdb_id ?? null;
    } else {
      const tv = await tmdb.getTv(tmdbId);
      imdbId = tv.external_ids?.imdb_id ?? null;
    }

    if (!imdbId) return null;

    const rating = await omdb.getRating(imdbId);
    if (rating.Response !== "True" || !rating.imdbRating || rating.imdbRating === "N/A") return null;
    return rating.imdbRating;
  }).catch(() => null);
}
