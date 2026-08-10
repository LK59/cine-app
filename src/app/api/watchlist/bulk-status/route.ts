import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth"
import { verifySessionFull } from "@/lib/session";
import { watchlistDb } from "@/lib/db";

// GET /api/watchlist/bulk-status?items=movie:123,series:456,...
// Returns { "movie:123": "favorite", "series:456": null, ... } — lets browsing surfaces
// (Discover, Recommendations, similar titles, collections, global search) show whether an
// item is already on the watchlist and under which status, instead of always looking
// "not yet added" until it's touched in the current page session.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  const userId = session?.jfId ?? session?.u ?? null;
  if (!userId) return NextResponse.json({});

  const raw = req.nextUrl.searchParams.get("items") ?? "";
  if (!raw) return NextResponse.json({});

  const ids = raw
    .split(",")
    .map((s) => {
      const [mediaType, id] = s.split(":");
      return { key: s, mediaType, tmdbId: Number(id) };
    })
    .filter((i) => i.tmdbId && (i.mediaType === "movie" || i.mediaType === "series"));

  const statusMap = watchlistDb.getBulkStatus(
    userId,
    ids.map(({ mediaType, tmdbId }) => ({ mediaType, tmdbId }))
  );

  const result: Record<string, string | null> = {};
  for (const { key } of ids) result[key] = statusMap.get(key) ?? null;

  return NextResponse.json(result);
}
