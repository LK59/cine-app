import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { PLAYBACK_CLIENTS, isPlaybackClient } from "@/lib/playbackClients";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { reportPlayback } from "@/lib/playbackReport";

/**
 * Tells Jellyfin a film has started playing.
 *
 * The stable player never needs this: negotiating its stream through /playback/start already
 * announces the session as a side effect. The experimental player negotiates nothing — it opens
 * the file itself — so without this it sent progress for a session the server had never been
 * told about, which left it out of "now playing" entirely and out of the history the
 * PlaybackReporting plugin keeps.
 */
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
  const playMethod = (body?.playMethod as "DirectPlay" | "DirectStream" | "Transcode" | undefined) ?? "DirectPlay";
  const client = isPlaybackClient(body?.client) ? body.client : PLAYBACK_CLIENTS.stable;
  if (!isJellyfinId(itemId) || !playSessionId || !mediaSourceId) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  const { jfId, jfToken } = session;
  return reportPlayback({ ...session, jfId }, "playing", itemId, 0, () =>
    jellyfin.reportPlaybackStart(jfId, itemId, jfToken, playSessionId, mediaSourceId, playMethod, client)
  );
}
