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
  if (movies.status === "fulfilled") {
    for (const m of movies.value) {
      if (m.tmdbId) movieMap[m.tmdbId] = m.id;
    }
  }

  const seriesMap: Record<number, number> = {};
  if (series.status === "fulfilled") {
    for (const s of series.value) {
      if (s.tmdbId) seriesMap[s.tmdbId] = s.id;
    }
  }

  return NextResponse.json({ movieMap, seriesMap });
}
