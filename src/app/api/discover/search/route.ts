import { NextRequest, NextResponse } from "next/server";
import { tmdb } from "@/lib/clients/tmdb";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const type = req.nextUrl.searchParams.get("type") ?? "movie";

  if (!tmdb.isEnabled()) {
    return NextResponse.json({ error: "TMDB not configured" }, { status: 503 });
  }
  if (q.length < 2) {
    return NextResponse.json({ items: [] });
  }

  if (type === "movie") {
    const [results, movies, movieGenres] = await Promise.all([
      tmdb.searchMovies(q).catch(() => ({ results: [] })),
      cachedMovies().catch(() => []),
      tmdb.movieGenres().catch(() => ({ genres: [] })),
    ]);

    const radarrByTmdb = new Map(movies.map((m) => [m.tmdbId, m.id]));
    const genreMap = new Map(movieGenres.genres.map((g) => [g.id, g.name]));

    const items = results.results.slice(0, 20).map((m) => {
      const radarrId = radarrByTmdb.get(m.id) ?? null;
      return {
        tmdbId: m.id,
        title: m.title,
        year: m.release_date ? Number(m.release_date.split("-")[0]) : null,
        overview: m.overview,
        posterPath: m.poster_path,
        rating: m.vote_average,
        genres: m.genre_ids.map((id) => genreMap.get(id)).filter(Boolean),
        radarrId,
        inLibrary: radarrId != null,
      };
    });

    return NextResponse.json({ items });
  } else {
    const [results, series, tvGenres] = await Promise.all([
      tmdb.searchTv(q).catch(() => ({ results: [] })),
      cachedSeries().catch(() => []),
      tmdb.tvGenres().catch(() => ({ genres: [] })),
    ]);

    const sonarrByTmdb = new Map(series.map((s) => [s.tmdbId, s.id]).filter(([k]) => k != null) as [number, number][]);
    const genreMap = new Map(tvGenres.genres.map((g) => [g.id, g.name]));

    const items = results.results.slice(0, 20).map((s) => {
      const sonarrId = sonarrByTmdb.get(s.id) ?? null;
      return {
        tmdbId: s.id,
        title: s.name,
        year: s.first_air_date ? Number(s.first_air_date.split("-")[0]) : null,
        overview: s.overview,
        posterPath: s.poster_path,
        rating: s.vote_average,
        genres: s.genre_ids.map((id) => genreMap.get(id)).filter(Boolean),
        sonarrId,
        inLibrary: sonarrId != null,
      };
    });

    return NextResponse.json({ items });
  }
}
