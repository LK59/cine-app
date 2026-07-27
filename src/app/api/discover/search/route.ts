import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, type TmdbTrendingMovie, type TmdbTrendingTv } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { titleMatchScore } from "@/lib/search-natural-query";

export const dynamic = "force-dynamic";

function bestScore(titles: (string | undefined)[], q: string): number {
  let best = 0;
  for (const title of titles) {
    if (!title) continue;
    best = Math.max(best, titleMatchScore(title, q));
  }
  return best;
}

export async function GET(req: NextRequest) {
  const siteLocale = getTmdbLocale(req.cookies.get("cine-lang")?.value);
  const tmdb = createTmdbClient(siteLocale);
  // Original/English titles ("The Hunt") often differ from the site's localized
  // title ("La Chasse") — search both so a query typed in either still matches.
  const tmdbEn = siteLocale === "en-US" ? tmdb : createTmdbClient("en-US");
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const type = req.nextUrl.searchParams.get("type") ?? "movie";

  if (!tmdb.isEnabled()) {
    return NextResponse.json({ error: "TMDB not configured" }, { status: 503 });
  }
  if (q.length < 2) {
    return NextResponse.json({ items: [] });
  }

  if (type === "movie") {
    const [results, resultsEn, movies, movieGenres] = await Promise.all([
      tmdb.searchMovies(q).catch(() => ({ results: [] })),
      tmdbEn === tmdb ? Promise.resolve({ results: [] }) : tmdbEn.searchMovies(q).catch(() => ({ results: [] })),
      cachedMovies().catch(() => []),
      tmdb.movieGenres().catch(() => ({ genres: [] })),
    ]);

    const radarrByTmdb = new Map(movies.map((m) => [m.tmdbId, { id: m.id, hasFile: m.hasFile }]));
    const genreMap = new Map(movieGenres.genres.map((g) => [g.id, g.name]));

    const enTitleById = new Map(resultsEn.results.map((m) => [m.id, m.title]));
    const merged = new Map<number, TmdbTrendingMovie>();
    for (const m of [...results.results, ...resultsEn.results]) {
      if (!merged.has(m.id)) merged.set(m.id, m);
    }

    const ranked = [...merged.values()].sort((a, b) => {
      const diff =
        bestScore([b.title, b.original_title, enTitleById.get(b.id)], q) -
        bestScore([a.title, a.original_title, enTitleById.get(a.id)], q);
      return diff !== 0 ? diff : (b.popularity ?? 0) - (a.popularity ?? 0);
    });

    const items = ranked.slice(0, 20).map((m) => {
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
    const [results, resultsEn, series, tvGenres] = await Promise.all([
      tmdb.searchTv(q).catch(() => ({ results: [] })),
      tmdbEn === tmdb ? Promise.resolve({ results: [] }) : tmdbEn.searchTv(q).catch(() => ({ results: [] })),
      cachedSeries().catch(() => []),
      tmdb.tvGenres().catch(() => ({ genres: [] })),
    ]);

    const sonarrByTmdb = new Map(
      series.filter((s) => s.tmdbId).map((s) => [s.tmdbId!, { id: s.id, hasFile: (s.statistics?.episodeFileCount ?? 0) > 0 }])
    );
    const genreMap = new Map(tvGenres.genres.map((g) => [g.id, g.name]));

    const enNameById = new Map(resultsEn.results.map((s) => [s.id, s.name]));
    const merged = new Map<number, TmdbTrendingTv>();
    for (const s of [...results.results, ...resultsEn.results]) {
      if (!merged.has(s.id)) merged.set(s.id, s);
    }

    const ranked = [...merged.values()].sort((a, b) => {
      const diff =
        bestScore([b.name, b.original_name, enNameById.get(b.id)], q) -
        bestScore([a.name, a.original_name, enNameById.get(a.id)], q);
      return diff !== 0 ? diff : (b.popularity ?? 0) - (a.popularity ?? 0);
    });

    const items = ranked.slice(0, 20).map((s) => {
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
