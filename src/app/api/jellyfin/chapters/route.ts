import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;
const TICKS_PER_SECOND = 10_000_000;

interface JellyfinChapter {
  StartPositionTicks: number;
  Name?: string;
}

export async function GET(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!itemId || !JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });

  // Same requirement as trickplay/info: /Items/{id} 400s without a UserId.
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return new NextResponse(null, { status: 401 });

  try {
    const res = await fetch(`${config.jellyfin.url}/Items/${itemId}?Fields=Chapters&UserId=${session.jfId}`, {
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
      headers: { "X-Emby-Token": config.jellyfin.apiKey },
    });
    if (!res.ok) return NextResponse.json([]);

    const item = (await res.json()) as { Chapters?: JellyfinChapter[] };
    const chapters = (item.Chapters ?? []).map((c, i) => ({
      start: c.StartPositionTicks / TICKS_PER_SECOND,
      name: c.Name?.trim() || `Chapitre ${i + 1}`,
    }));
    return NextResponse.json(chapters);
  } catch {
    return NextResponse.json([]);
  }
}
