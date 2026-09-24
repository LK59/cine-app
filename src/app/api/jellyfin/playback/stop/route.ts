import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { PLAYBACK_CLIENTS, isPlaybackClient } from "@/lib/playbackClients";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { reportPlayback } from "@/lib/playbackReport";

export async function POST(req: NextRequest) {
  if (!config.player.enabled) {
    return NextResponse.json({ error: "Lecteur intégré désactivé" }, { status: 404 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionFull(token);

  if (!session?.jfId || !session?.jfToken) {
    return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const itemId = body?.itemId as string | undefined;
  const playSessionId = body?.playSessionId as string | undefined;
  const mediaSourceId = body?.mediaSourceId as string | undefined;
  const positionTicks = Number(body?.positionTicks) || 0;
  const client = isPlaybackClient(body?.client) ? body.client : PLAYBACK_CLIENTS.stable;

  if (!itemId || !playSessionId || !mediaSourceId) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  const { jfId, jfToken } = session;
  return reportPlayback({ ...session, jfId }, "stop", itemId, positionTicks, () =>
    jellyfin.reportPlaybackStopped(jfId, itemId, jfToken, playSessionId, mediaSourceId, positionTicks, client)
  );
}
