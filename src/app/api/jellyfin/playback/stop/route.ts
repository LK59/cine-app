import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { PLAYBACK_CLIENTS, isPlaybackClient } from "@/lib/playbackClients";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { reportPlayback } from "@/lib/playbackReport";
import { castProgressRelay } from "@/lib/castProgress";
import { playbackDevice } from "@/lib/playbackDevice";
import { recoverLostPosition } from "@/lib/lostStopPosition";

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

  /**
   * Une position restée sur l'appareil pendant une coupure, envoyée après coup (`unsentPosition.ts`,
   * DECISIONS.md §78) : plus aucune séance Jellyfin à arrêter, seulement une position à rendre — par
   * la règle des bilans perdus, qui n'avance jamais qu'une position, et seulement si rien n'a été lu
   * depuis (`recoverLostPosition`).
   */
  if (body?.late === true) {
    const lateByMs = Number(body?.lateByMs);
    if (!isJellyfinId(itemId) || !(positionTicks > 0) || !Number.isFinite(lateByMs) || lateByMs < 0) {
      return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
    }
    const result = await recoverLostPosition(
      session.jfId,
      { why: "lost", itemId, at: positionTicks / 10_000_000, lateByMs },
      Date.now()
    ).catch(() => null);
    if (result === null) return NextResponse.json({ error: "Jellyfin injoignable" }, { status: 502 });
    return NextResponse.json({ result });
  }

  if (!isJellyfinId(itemId) || !playSessionId || !mediaSourceId) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  const { jfId, jfToken } = session;
  // La page parle pour ce titre : le relais du serveur se tait (`castProgress.ts`, DECISIONS.md §64).
  castProgressRelay().notePageReport(jfId, itemId);
  // L'appareil de la connexion et son vrai nom, plus un appareil fantôme par compte — `playbackDevice.ts`.
  const device = playbackDevice(req, session.jti);
  return reportPlayback({ ...session, jfId }, "stop", itemId, positionTicks, () =>
    jellyfin.reportPlaybackStopped(jfId, itemId, jfToken, playSessionId, mediaSourceId, positionTicks, client, device)
  );
}
