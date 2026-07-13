import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { cachedMovies } from "@/lib/server-cache";

export async function GET(req: NextRequest) {
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
  if (!tmdb.isEnabled()) {
    return NextResponse.json({ error: "TMDB_API_KEY non configurée" }, { status: 503 });
  }

  const [trending, genres, radarrMovies] = await Promise.all([
    tmdb.trendingMovies().catch(() => ({ results: [] })),
    tmdb.movieGenres().catch(() => ({ genres: [] })),
    cachedMovies().catch(() => []),
  ]);

  const genreMap = new Map(genres.genres.map((g) => [g.id, g.name]));
  const radarrMap = new Map(radarrMovies.map((m) => [m.tmdbId, { id: m.id, hasFile: m.hasFile }]));

  const items = trending.results.map((m) => ({
    tmdbId: m.id,
    title: m.title,
    year: m.release_date ? new Date(m.release_date).getFullYear() : null,
    overview: m.overview,
    posterPath: m.poster_path,
    backdropPath: m.backdrop_path,
    rating: Math.round(m.vote_average * 10) / 10,
    genres: m.genre_ids.map((id) => genreMap.get(id)).filter(Boolean) as string[],
    radarrId: radarrMap.get(m.id)?.id ?? null,
    inLibrary: radarrMap.get(m.id)?.hasFile ?? false,
  }));

  return NextResponse.json({ items, genres: genres.genres.map((g) => g.name) });
}
