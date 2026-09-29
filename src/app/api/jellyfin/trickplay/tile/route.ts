import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { assertVisible } from "@/lib/itemVisibility";

// One tile is a sprite sheet covering many thumbnails (see trickplay/info/route.ts) — a modest
// number of distinct tiles covers a whole movie, so caching them aggressively is safe and cuts
// repeat network cost during a single scrub session to near zero after the first pass.
export async function GET(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const itemId = req.nextUrl.searchParams.get("itemId");
  const width = req.nextUrl.searchParams.get("width");
  const index = req.nextUrl.searchParams.get("index");
  if (!isJellyfinId(itemId)) return new NextResponse(null, { status: 400 });
  if (!width || !/^\d+$/.test(width) || !index || !/^\d+$/.test(index)) {
    return new NextResponse(null, { status: 400 });
  }

  // Signé avec la clé d'administration, qui voit tout : le droit du compte sur ce titre est
  // demandé à Jellyfin d'abord, une fois par séance — voir `assertVisible`.
  const refused = await assertVisible(await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value), itemId);
  if (refused) return refused;

  try {
    const res = await fetch(
      `${config.jellyfin.url}/Videos/${itemId}/Trickplay/${width}/${index}.jpg?MediaSourceId=${itemId}`,
      {
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
        headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
      }
    );
    if (!res.ok) return new NextResponse(null, { status: 404 });

    const blob = await res.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
        // `private` : des images du film, servies à une session seulement — aucun cache partagé ne
        // doit les resservir (26/09/2026, comme le relais de flux).
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
