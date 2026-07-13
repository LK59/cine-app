import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { jellyfin } from "@/lib/clients/jellyfin";
import { createTmdbClient } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
  if (!tmdb.isEnabled()) {
    return NextResponse.json({ error: "TMDB not configured" }, { status: 503 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) {
    return NextResponse.json({ items: [] });
  }

  const [playedMovies, playedSeries, radarrMovies, sonarrSeries, movieGenres, tvGenres] =
    await Promise.all([
      jellyfin.getRecentlyPlayed(session.jfId, "Movie", 10).catch(() => ({ Items: [] })),
      jellyfin.getRecentlyPlayed(session.jfId, "Episode", 10).catch(() => ({ Items: [] })),
      cachedMovies().catch(() => []),
      cachedSeries().catch(() => []),
      tmdb.movieGenres().catch(() => ({ genres: [] })),
      tmdb.tvGenres().catch(() => ({ genres: [] })),
    ]);

  const radarrTmdbIds = new Set(radarrMovies.filter((m) => m.hasFile).map((m) => m.tmdbId));
  const sonarrTmdbIds = new Set(sonarrSeries.filter((s) => (s.statistics?.episodeFileCount ?? 0) > 0).map((s) => s.tmdbId).filter(Boolean));

  const movieGenreMap = new Map(movieGenres.genres.map((g) => [g.id, g.name]));
  const tvGenreMap = new Map(tvGenres.genres.map((g) => [g.id, g.name]));

  // Collect unique TMDB IDs from recently played (limit source items)
  const getCI = (ids: Record<string, string> | undefined) =>
    Object.entries(ids ?? {}).find(([k]) => k.toLowerCase() === "tmdb")?.[1];

  const movieTmdbIds = [
    ...new Set(
      playedMovies.Items.map((i) => Number(getCI(i.ProviderIds))).filter(Boolean)
    ),
  ].slice(0, 5);

  // For series, pull parent series IDs from recently played episodes
  const seriesTmdbIds = [
    ...new Set(
      playedSeries.Items.map((i) => Number(getCI(i.ProviderIds))).filter(Boolean)
    ),
  ].slice(0, 5);

  // Fetch recommendations in parallel
  const movieRecResults = await Promise.allSettled(
    movieTmdbIds.map((id) => tmdb.movieRecommendations(id).catch(() => ({ results: [] })))
  );
  const tvRecResults = await Promise.allSettled(
    seriesTmdbIds.map((id) => tmdb.tvRecommendations(id).catch(() => ({ results: [] })))
  );

  const seen = new Set<string>();
  const items: any[] = [];

  // Process movie recommendations
  for (const result of movieRecResults) {
    if (result.status !== "fulfilled") continue;
    for (const movie of result.value.results.slice(0, 10)) {
      const key = `movie-${movie.id}`;
      if (seen.has(key) || radarrTmdbIds.has(movie.id)) continue;
      seen.add(key);
      items.push({
        tmdbId: movie.id,
        title: movie.title,
        year: movie.release_date ? Number(movie.release_date.split("-")[0]) : null,
        overview: movie.overview,
        posterPath: movie.poster_path,
        rating: movie.vote_average,
        genres: movie.genre_ids.map((id) => movieGenreMap.get(id)).filter(Boolean),
        type: "movie" as const,
        inLibrary: false,
      });
    }
  }

  // Process TV recommendations
  for (const result of tvRecResults) {
    if (result.status !== "fulfilled") continue;
    for (const tv of result.value.results.slice(0, 10)) {
      const key = `tv-${tv.id}`;
      if (seen.has(key) || sonarrTmdbIds.has(tv.id)) continue;
      seen.add(key);
      items.push({
        tmdbId: tv.id,
        title: tv.name,
        year: tv.first_air_date ? Number(tv.first_air_date.split("-")[0]) : null,
        overview: tv.overview,
        posterPath: tv.poster_path,
        rating: tv.vote_average,
        genres: tv.genre_ids.map((id) => tvGenreMap.get(id)).filter(Boolean),
        type: "tv" as const,
        inLibrary: false,
      });
    }
  }

  // Sort by rating, cap at 24
  items.sort((a, b) => b.rating - a.rating);

  return NextResponse.json({ items: items.slice(0, 24), hasHistory: movieTmdbIds.length + seriesTmdbIds.length > 0 });
}
