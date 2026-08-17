import { NextRequest, NextResponse } from "next/server";
import { omdb } from "@/lib/clients/omdb";
import { getImdbRating } from "@/lib/imdb-rating";

export const dynamic = "force-dynamic";

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
