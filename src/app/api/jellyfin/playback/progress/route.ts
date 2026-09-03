import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { PLAYBACK_CLIENTS, isPlaybackClient } from "@/lib/playbackClients";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";

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
  const positionTicks = Number(body?.positionTicks);
  const playMethod = (body?.playMethod as "DirectPlay" | "DirectStream" | "Transcode" | undefined) ?? "Transcode";
  // Chosen by the browser, so matched against the two names this app plays under rather than
  // passed through: it lands in Jellyfin's session list and its history.
  const client = isPlaybackClient(body?.client) ? body.client : PLAYBACK_CLIENTS.stable;
  const isPaused = body?.isPaused === true;

  if (!itemId || !playSessionId || !mediaSourceId || !Number.isFinite(positionTicks)) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  try {
    await jellyfin.reportPlaybackProgress(
      session.jfId,
      itemId,
      session.jfToken,
      playSessionId,
      mediaSourceId,
      positionTicks,
      playMethod,
      client,
      isPaused
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur Jellyfin" },
      { status: 502 }
    );
  }
}
