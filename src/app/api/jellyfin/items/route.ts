import { NextRequest } from "next/server";
import { withErrorHandling } from "@/lib/api-helpers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import {
  cachedJellyfinMovies,
  cachedJellyfinMoviesAdmin,
  cachedJellyfinSeries,
  cachedJellyfinSeriesAdmin,
  findJellyfinMovieByTmdb,
  findJellyfinSeriesByTvdb,
} from "@/lib/server-cache";

export async function GET(req: NextRequest) {
  const tmdbId = req.nextUrl.searchParams.get("tmdbId");
  const tvdbId = req.nextUrl.searchParams.get("tvdbId");
  const type   = req.nextUrl.searchParams.get("type") ?? "Movie";
  const title  = req.nextUrl.searchParams.get("title") ?? undefined;
  const imdbId = req.nextUrl.searchParams.get("imdbId") ?? null;
  const year   = req.nextUrl.searchParams.get("year") ? Number(req.nextUrl.searchParams.get("year")) : undefined;

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  const userId = session?.jfId;

  return withErrorHandling(async () => {
    let item = null;

    if (type === "Movie") {
      // Always try admin list first — it sees the full library regardless of user permissions
      const adminMovies = await cachedJellyfinMoviesAdmin();
      item = findJellyfinMovieByTmdb(adminMovies, Number(tmdbId ?? 0), title, year, imdbId);

      // If found and user is logged in, enrich with UserData (played/unplayed) from user list
      if (item && userId) {
        const userMovies = await cachedJellyfinMovies(userId).catch(() => null);
        const userItem = userMovies
          ? findJellyfinMovieByTmdb(userMovies, Number(tmdbId ?? 0), title, year, imdbId)
          : null;
        if (userItem) item = userItem; // prefer user item for UserData
      }
    } else if (type === "Series") {
      const adminSeries = await cachedJellyfinSeriesAdmin();
      item = findJellyfinSeriesByTvdb(adminSeries, Number(tvdbId ?? 0), title, year);

      if (item && userId) {
        const userSeries = await cachedJellyfinSeries(userId).catch(() => null);
        const userItem = userSeries
          ? findJellyfinSeriesByTvdb(userSeries, Number(tvdbId ?? 0), title, year)
          : null;
        if (userItem) item = userItem;
      }
    }

    return { item };
  });
}
