import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

// One tile is a sprite sheet covering many thumbnails (see trickplay/info/route.ts) — a modest
// number of distinct tiles covers a whole movie, so caching them aggressively is safe and cuts
// repeat network cost during a single scrub session to near zero after the first pass.
export async function GET(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const itemId = req.nextUrl.searchParams.get("itemId");
  const width = req.nextUrl.searchParams.get("width");
  const index = req.nextUrl.searchParams.get("index");
  if (!itemId || !JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });
  if (!width || !/^\d+$/.test(width) || !index || !/^\d+$/.test(index)) {
    return new NextResponse(null, { status: 400 });
  }

  try {
    const res = await fetch(
      `${config.jellyfin.url}/Videos/${itemId}/Trickplay/${width}/${index}.jpg?MediaSourceId=${itemId}`,
      {
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
        headers: { "X-Emby-Token": config.jellyfin.apiKey },
      }
    );
    if (!res.ok) return new NextResponse(null, { status: 404 });

    const blob = await res.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
