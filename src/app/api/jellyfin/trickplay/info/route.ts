import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { fetchTrickplayInfo } from "@/lib/trickplay";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

export async function GET(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });

  const itemId = req.nextUrl.searchParams.get("itemId");
  if (!itemId || !JELLYFIN_ID_RE.test(itemId)) return new NextResponse(null, { status: 400 });

  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) return new NextResponse(null, { status: 401 });

  try {
    const info = await fetchTrickplayInfo(
      itemId,
      session.jfId,
      AbortSignal.any([req.signal, AbortSignal.timeout(8000)])
    );
    if (!info) return new NextResponse(null, { status: 404 });
    return NextResponse.json(info);
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
