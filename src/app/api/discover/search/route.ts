import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
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

    const radarrByTmdb = new Map(movies.map((m) => [m.tmdbId, { id: m.id, hasFile: m.hasFile }]));
    const genreMap = new Map(movieGenres.genres.map((g) => [g.id, g.name]));

    const items = results.results.slice(0, 20).map((m) => {
      const radarr = radarrByTmdb.get(m.id) ?? null;
      return {
        tmdbId: m.id,
        title: m.title,
        year: m.release_date ? Number(m.release_date.split("-")[0]) : null,
        overview: m.overview,
        posterPath: m.poster_path,
        rating: m.vote_average,
        genres: m.genre_ids.map((id) => genreMap.get(id)).filter(Boolean),
        radarrId: radarr?.id ?? null,
        inLibrary: radarr?.hasFile ?? false,
      };
    });

    return NextResponse.json({ items });
  } else {
    const [results, series, tvGenres] = await Promise.all([
      tmdb.searchTv(q).catch(() => ({ results: [] })),
      cachedSeries().catch(() => []),
      tmdb.tvGenres().catch(() => ({ genres: [] })),
    ]);

    const sonarrByTmdb = new Map(
      series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, { id: s.id, hasFile: (s.statistics?.episodeFileCount ?? 0) > 0 }])
    );
    const genreMap = new Map(tvGenres.genres.map((g) => [g.id, g.name]));

    const items = results.results.slice(0, 20).map((s) => {
      const sonarr = sonarrByTmdb.get(s.id) ?? null;
      return {
        tmdbId: s.id,
        title: s.name,
        year: s.first_air_date ? Number(s.first_air_date.split("-")[0]) : null,
        overview: s.overview,
        posterPath: s.poster_path,
        rating: s.vote_average,
        genres: s.genre_ids.map((id) => genreMap.get(id)).filter(Boolean),
        sonarrId: sonarr?.id ?? null,
        inLibrary: sonarr?.hasFile ?? false,
      };
    });

    return NextResponse.json({ items });
  }
}
