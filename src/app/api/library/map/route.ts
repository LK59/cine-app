import { NextResponse } from "next/server";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

// Returns lightweight maps: tmdbId → radarrId and tmdbId → sonarrId
// Used by watchlist page to link items to their library pages
export async function GET() {
  const [movies, series] = await Promise.allSettled([
    cachedMovies(),
    cachedSeries(),
  ]);

  const movieMap: Record<number, number> = {};
  const hasFileMovieIds: number[] = [];
  if (movies.status === "fulfilled") {
    for (const m of movies.value) {
      if (m.tmdbId) {
        movieMap[m.tmdbId] = m.id;
        if (m.hasFile) hasFileMovieIds.push(m.tmdbId);
      }
    }
  }

  const seriesMap: Record<number, number> = {};
  const hasFileSeriesIds: number[] = [];
  if (series.status === "fulfilled") {
    for (const s of series.value) {
      if (s.tmdbId) {
        seriesMap[s.tmdbId] = s.id;
        if ((s.statistics?.episodeFileCount ?? 0) > 0) hasFileSeriesIds.push(s.tmdbId);
      }
    }
  }

  return NextResponse.json({ movieMap, seriesMap, hasFileMovieIds, hasFileSeriesIds });
}
