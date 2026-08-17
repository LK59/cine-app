import { tmdb } from "@/lib/clients/tmdb";
import { omdb } from "@/lib/clients/omdb";
import { withPersistentCache } from "@/lib/server-cache";

// Resolves TMDB id → IMDb rating string (e.g. "7.4"), cached 24h. Shared by the watchlist
// ratings route and the dashboard's "recently added series" row — Sonarr's own `ratings` field
// (unlike Radarr's) isn't IMDb-specific, so series need this TMDB→imdb_id→OMDb resolution;
// movies read Radarr's own ratings.imdb.value directly instead, which needs no external call.
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
