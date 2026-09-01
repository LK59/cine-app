import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { fetchTrickplayInfo, pickPreviewFrames } from "@/lib/trickplay";
import {
  cachedJellyfinMoviesAdmin,
  cachedJellyfinSeriesAdmin,
  findJellyfinMovieByTmdb,
  getProviderIdCI,
} from "@/lib/server-cache";

// Resolves a poster's tmdbId to a Jellyfin item (reusing the same admin-scoped library lists and
// movie-matching helper as /api/jellyfin/items) and, only if that item already has trickplay data
// generated, returns a handful of frame indices spread across the runtime — see
// pickPreviewFrames in @/lib/trickplay for why they're spread out rather than consecutive. The
// browser then fetches each frame's sprite tile directly from the existing
// /api/jellyfin/trickplay/tile endpoint as it cycles through them on hover.
export async function GET(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const tmdbIdParam = req.nextUrl.searchParams.get("tmdbId");
  const mediaType = req.nextUrl.searchParams.get("mediaType");
  const tmdbId = tmdbIdParam ? Number(tmdbIdParam) : NaN;
  if (!Number.isFinite(tmdbId) || tmdbId <= 0 || (mediaType !== "movie" && mediaType !== "series")) {
    return new NextResponse(null, { status: 400 });
  }

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return new NextResponse(null, { status: 401 });

  try {
    const item =
      mediaType === "movie"
        ? findJellyfinMovieByTmdb(await cachedJellyfinMoviesAdmin(), tmdbId)
        // Series aren't matched via findJellyfinSeriesByTvdb here — that helper's primary key is
        // TVDB (what Sonarr identifies series by), but PosterCard only ever has a tmdbId on hand.
        // Jellyfin still carries a Tmdb provider id on series items, so match on that directly.
        : (await cachedJellyfinSeriesAdmin()).find((s) => getProviderIdCI(s.ProviderIds, "tmdb") === String(tmdbId));
    if (!item) return new NextResponse(null, { status: 404 });

    const info = await fetchTrickplayInfo(
      item.Id,
      session.jfId,
      AbortSignal.any([req.signal, AbortSignal.timeout(8000)])
    );
    if (!info) return new NextResponse(null, { status: 404 });

    const frames = pickPreviewFrames(info.thumbnailCount, info.intervalMs);
    if (frames.length === 0) return new NextResponse(null, { status: 404 });

    return NextResponse.json(
      {
        itemId: item.Id,
        width: info.width,
        height: info.height,
        tileWidth: info.tileWidth,
        tileHeight: info.tileHeight,
        frames,
      },
      // Library rarely changes mid-session — safe to let the browser skip re-resolving the same
      // poster's preview on every re-hover for a while.
      { headers: { "Cache-Control": "private, max-age=1800" } }
    );
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
