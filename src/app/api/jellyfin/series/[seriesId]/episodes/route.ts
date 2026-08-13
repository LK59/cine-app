import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

const JELLYFIN_ID_RE = /^[0-9a-f]{32}$/i;

export async function GET(req: NextRequest, { params }: { params: Promise<{ seriesId: string }> }) {
  const { seriesId } = await params;
  if (!JELLYFIN_ID_RE.test(seriesId)) {
    return NextResponse.json({ error: "seriesId invalide" }, { status: 400 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);
  if (!session?.jfId) {
    return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });
  }

  try {
    const [episodes, nextUp] = await Promise.all([
      jellyfin.getSeriesEpisodes(session.jfId, seriesId),
      jellyfin.getNextUp(session.jfId, seriesId),
    ]);
    return NextResponse.json({ episodes, nextUp });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur Jellyfin" },
      { status: 502 }
    );
  }
}
