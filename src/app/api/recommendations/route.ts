import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { cachedJellyfinMovies, cachedJellyfinMoviesAdmin, withCache, TTL } from "@/lib/server-cache";
import { cachedMovies } from "@/lib/server-cache";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG  = "https://image.tmdb.org/t/p/w342";

export interface RecommendedMovie {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  overview: string;
  voteAverage: number;
  inLibrary: boolean;
  radarrId?: number;
}

export interface RecommendationGroup {
  seedTitle: string;
  seedTmdbId: number;
  seedPosterPath: string | null;
  movies: RecommendedMovie[];
}

async function fetchTmdbRecs(tmdbId: number): Promise<any[]> {
  const key = config.tmdb.apiKey;
  if (!key) return [];
  const res = await fetch(
    `${TMDB_BASE}/movie/${tmdbId}/recommendations?language=fr-FR&page=1&api_key=${key}`
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  const userId = session?.jfId ?? null;

  const cacheKey = `recommendations:${userId ?? "anon"}`;

  const groups = await withCache<RecommendationGroup[]>(cacheKey, TTL.RECOMMENDATIONS, async () => {
    // Get recently watched movies from Jellyfin (with UserData.Played)
    const jfMovies = userId
      ? await cachedJellyfinMovies(userId).catch(() => null)
      : await cachedJellyfinMoviesAdmin().catch(() => null);

    const radarrMovies = await cachedMovies().catch(() => []);
    const libraryTmdbIds = new Set(radarrMovies.map((m) => m.tmdbId).filter(Boolean));
    const radarrByTmdb = new Map(radarrMovies.map((m) => [m.tmdbId, m.id]));

    if (!jfMovies) return [];

    // Pick recently played movies that have a TMDb ID — up to 8 seed movies
    const watched = jfMovies
      .filter((m) => m.UserData?.Played && m.ProviderIds)
      .map((m) => {
        const tmdbId = Number(m.ProviderIds?.Tmdb ?? 0);
        return { tmdbId, name: m.Name, posterPath: null as string | null };
      })
      .filter((m) => m.tmdbId > 0)
      .slice(-8) // last 8 (most recently watched are at the end in Jellyfin ordering)
      .reverse(); // most recent first

    if (watched.length === 0) return [];

    // Fetch recommendations for each seed movie in parallel
    const results = await Promise.allSettled(
      watched.map(async (seed) => {
        const recs = await fetchTmdbRecs(seed.tmdbId);
        const movies: RecommendedMovie[] = recs
          .filter((r) => r.poster_path && r.vote_average > 6)
          .slice(0, 8)
          .map((r) => ({
            tmdbId: r.id,
            title: r.title,
            year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
            posterPath: `${TMDB_IMG}${r.poster_path}`,
            overview: r.overview ?? "",
            voteAverage: r.vote_average,
            inLibrary: libraryTmdbIds.has(r.id),
            radarrId: radarrByTmdb.get(r.id),
          }));

        return {
          seedTitle: seed.name,
          seedTmdbId: seed.tmdbId,
          seedPosterPath: null as string | null,
          movies,
        } as RecommendationGroup;
      })
    );

    return results
      .filter((r): r is PromiseFulfilledResult<RecommendationGroup> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((g) => g.movies.length > 0);
  });

  return NextResponse.json({ groups });
}
