import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

interface TrickplayResolution {
  Width: number;
  Height: number;
  TileWidth: number;
  TileHeight: number;
  ThumbnailCount: number;
  Interval: number;
}

// Jellyfin's trickplay grid: each fetched "tile" is itself a sprite sheet of TileWidth x
// TileHeight individual Width x Height thumbnails, taken every `Interval` ms through the file.
// The client locates a thumbnail for a given seek time by: thumbnailIndex = time_ms / Interval,
// tileIndex = thumbnailIndex / (TileWidth * TileHeight), and its row/col within that tile via
// the remainder — see PlayerControls' seek-preview code.
export async function GET(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!itemId || !JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });

  try {
    const res = await fetch(`${config.jellyfin.url}/Items/${itemId}?Fields=Trickplay`, {
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
      headers: { "X-Emby-Token": config.jellyfin.apiKey },
    });
    if (!res.ok) return new NextResponse(null, { status: 404 });

    const item = (await res.json()) as { Trickplay?: Record<string, Record<string, TrickplayResolution>> };
    const resolutions = item.Trickplay?.[itemId];
    if (!resolutions) return new NextResponse(null, { status: 404 });

    // Smallest available width — plenty for a small scrubbing preview, and keeps each tile
    // image (already a Width*TileWidth by Height*TileHeight sprite sheet) light to fetch.
    const [width, info] = Object.entries(resolutions).sort(([a], [b]) => Number(a) - Number(b))[0];

    return NextResponse.json({
      width: Number(width),
      height: info.Height,
      tileWidth: info.TileWidth,
      tileHeight: info.TileHeight,
      thumbnailCount: info.ThumbnailCount,
      intervalMs: info.Interval,
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
