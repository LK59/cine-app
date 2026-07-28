import { NextRequest, NextResponse } from "next/server";
import { tmdb } from "@/lib/clients/tmdb";
import { omdb } from "@/lib/clients/omdb";
import { withPersistentCache } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

// Resolves TMDB id → IMDb rating string (e.g. "7.4"), cached 24h
async function getImdbRating(tmdbId: number, mediaType: "movie" | "series"): Promise<string | null> {
  // The fallback lives outside withCache: a transient TMDB/OMDb failure must not get cached as
  // "no rating" for 24h — better to just retry next time. A genuine "no IMDb id"/"no rating"
  // result is a real `null` returned normally below, so it still caches correctly.
  return withPersistentCache(`imdb:rating:${mediaType}:${tmdbId}`, 24 * 3600_000, async () => {
    let imdbId: string | null = null;

    if (mediaType === "movie") {
      const movie = await tmdb.getMovie(tmdbId);
      imdbId = movie.imdb_id ?? null;
    } else {
      const tv = await tmdb.getTv(tmdbId);
      imdbId = tv.external_ids?.imdb_id ?? null;
    }

    if (!imdbId) return null;

    const rating = await omdb.getRating(imdbId);
    if (rating.Response !== "True" || !rating.imdbRating || rating.imdbRating === "N/A") return null;
    return rating.imdbRating;
  }).catch(() => null);
}

// GET /api/watchlist/ratings?items=movie:123,series:456,...
// Returns { "movie:123": "7.4", "series:456": "8.1", ... }
export async function GET(req: NextRequest) {
  if (!omdb.isEnabled()) return NextResponse.json({});

  const raw = req.nextUrl.searchParams.get("items") ?? "";
  if (!raw) return NextResponse.json({});

  const items = raw
    .split(",")
    .map((s) => {
      const [type, id] = s.split(":");
      return { key: s, mediaType: type as "movie" | "series", tmdbId: Number(id) };
    })
    .filter((i) => i.tmdbId && (i.mediaType === "movie" || i.mediaType === "series"));

  const result: Record<string, string | null> = {};

  // All resolved concurrently — each call is individually cached so no stampede risk
  const ratings = await Promise.all(items.map((item) => getImdbRating(item.tmdbId, item.mediaType)));
  items.forEach((item, i) => { result[item.key] = ratings[i]; });

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
