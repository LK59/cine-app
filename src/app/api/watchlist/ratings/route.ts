import { NextRequest, NextResponse } from "next/server";
import { tmdb } from "@/lib/clients/tmdb";
import { omdb } from "@/lib/clients/omdb";
import { withCache } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

// Resolves TMDB id → IMDb rating string (e.g. "7.4"), cached 24h
async function getImdbRating(tmdbId: number, mediaType: "movie" | "series"): Promise<string | null> {
  return withCache(`imdb:rating:${mediaType}:${tmdbId}`, 24 * 3600_000, async () => {
    let imdbId: string | null = null;

    if (mediaType === "movie") {
      const movie = await tmdb.getMovie(tmdbId).catch(() => null);
      imdbId = movie?.imdb_id ?? null;
    } else {
      const tv = await tmdb.getTv(tmdbId).catch(() => null);
      imdbId = tv?.external_ids?.imdb_id ?? null;
    }

    if (!imdbId) return null;

    const rating = await omdb.getRating(imdbId).catch(() => null);
    if (rating?.Response !== "True" || !rating.imdbRating || rating.imdbRating === "N/A") return null;
    return rating.imdbRating;
  });
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

  // Batch 5 at a time to avoid overwhelming downstream APIs
  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5);
    const ratings = await Promise.all(batch.map((item) => getImdbRating(item.tmdbId, item.mediaType)));
    batch.forEach((item, j) => { result[item.key] = ratings[j]; });
  }

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
