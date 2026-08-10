import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { withCache, TTL } from "@/lib/server-cache";
import { cachedMovies } from "@/lib/server-cache";
import { jellyfin } from "@/lib/clients/jellyfin";
import { config } from "@/lib/config";
import { getTmdbLocale } from "@/lib/i18n";

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

async function fetchTmdbRecs(tmdbId: number, lang: string): Promise<any[]> {
  const key = config.tmdb.apiKey;
  if (!key) return [];
  const res = await fetch(
    `${TMDB_BASE}/movie/${tmdbId}/recommendations?language=${lang}&page=1&api_key=${key}`
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.results ?? [];
}

export async function GET(req: NextRequest) {
  const tmdbLang = getTmdbLocale(req.cookies.get("cine-lang")?.value);
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  const userId = session?.jfId ?? null;

  const cacheKey = `recommendations:${userId ?? "anon"}`;

  const groups = await withCache<RecommendationGroup[]>(cacheKey, TTL.RECOMMENDATIONS, async () => {
    // Without a Jellyfin SSO session there's no per-user watch history to seed
    // recommendations from — the admin-scoped Items endpoint doesn't carry UserData at all
    // (no /Users/{id} context), so it can never report anything as "played".
    if (!userId) return [];

    // getRecentlyPlayed is explicitly sorted by DatePlayed desc — unlike the plain movie-list
    // endpoints (no SortBy, Jellyfin defaults to alphabetical), which used to be fetched here and
    // sliced assuming the *last* items were the most recently watched. They weren't: that seeded
    // recommendations off whichever played movies happened to sort last alphabetically.
    const recentlyPlayed = await jellyfin.getRecentlyPlayed(userId, "Movie", 8).catch(() => null);

    const radarrMovies = await cachedMovies().catch(() => []);
    const libraryTmdbIds = new Set(radarrMovies.filter((m) => m.hasFile).map((m) => m.tmdbId).filter(Boolean));
    const radarrByTmdb = new Map(radarrMovies.map((m) => [m.tmdbId, m.id]));

    if (!recentlyPlayed) return [];

    // Pick recently played movies that have a TMDb ID — up to 8 seed movies, most recent first
    const watched = recentlyPlayed.Items
      .filter((m) => m.ProviderIds)
      .map((m) => {
        const tmdbId = Number(
          Object.entries(m.ProviderIds ?? {}).find(([k]) => k.toLowerCase() === "tmdb")?.[1] ?? 0
        );
        return { tmdbId, name: m.Name, posterPath: null as string | null };
      })
      .filter((m) => m.tmdbId > 0);

    if (watched.length === 0) return [];

    // Fetch recommendations for each seed movie in parallel
    const results = await Promise.allSettled(
      watched.map(async (seed) => {
        const recs = await fetchTmdbRecs(seed.tmdbId, tmdbLang);
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
