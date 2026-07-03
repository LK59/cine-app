import { NextResponse } from "next/server";
import { tmdb } from "@/lib/clients/tmdb";
import { cachedSeries } from "@/lib/server-cache";

export async function GET() {
  if (!tmdb.isEnabled()) {
    return NextResponse.json({ error: "TMDB_API_KEY non configurée" }, { status: 503 });
  }

  const [trending, genres, sonarrSeries] = await Promise.all([
    tmdb.trendingTv().catch(() => ({ results: [] })),
    tmdb.tvGenres().catch(() => ({ genres: [] })),
    cachedSeries().catch(() => []),
  ]);

  const genreMap = new Map(genres.genres.map((g) => [g.id, g.name]));
  const inLibraryByTmdb = new Map(
    sonarrSeries.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, s.id])
  );

  const items = trending.results.map((s) => ({
    tmdbId: s.id,
    title: s.name,
    year: s.first_air_date ? new Date(s.first_air_date).getFullYear() : null,
    overview: s.overview,
    posterPath: s.poster_path,
    backdropPath: s.backdrop_path,
    rating: Math.round(s.vote_average * 10) / 10,
    genres: s.genre_ids.map((id) => genreMap.get(id)).filter(Boolean) as string[],
    sonarrId: inLibraryByTmdb.get(s.id) ?? null,
    inLibrary: inLibraryByTmdb.has(s.id),
  }));

  return NextResponse.json({ items, genres: genres.genres.map((g) => g.name) });
}
