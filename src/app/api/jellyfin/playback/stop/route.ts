import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { PLAYBACK_CLIENTS, currentPlaybackClient } from "@/lib/playbackClients";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { shareRefusal } from "@/lib/share/guard";
import { config } from "@/lib/config";
import { reportPlayback } from "@/lib/playbackReport";
import { castProgressRelay } from "@/lib/castProgress";
import { playbackDevice } from "@/lib/playbackDevice";
import { recoverLostPosition } from "@/lib/lostStopPosition";
import { takePrewarmSession } from "@/lib/prewarmSessions";
import { forgetTranscode } from "@/lib/transcodeBudget";

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
  // Un lien de partage ne parle que de son titre (DECISIONS.md §112).
  const shareRefused = await shareRefusal(session, itemId);
  if (shareRefused) return shareRefused;
  const playSessionId = body?.playSessionId as string | undefined;
  // Sa place parmi les cinq transcodages du compte se libère (`transcodeBudget.ts`, 20/10/2026).
  forgetTranscode(session.jfId, playSessionId);
  const mediaSourceId = body?.mediaSourceId as string | undefined;
  const positionTicks = Number(body?.positionTicks) || 0;
  const client = currentPlaybackClient(body?.client) ?? PLAYBACK_CLIENTS.stable;

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

  /**
   * Un préchauffage abandonné (§78, `lighterPrewarm.ts`) : le lecteur natif a trouvé son image. Rien
   * n'a été annoncé à Jellyfin, aucune position n'est à écrire : seul le transcodage est arrêté
   * (`DELETE /Videos/ActiveEncodings`, à la clé d'administration — la séance du préchauffage est celle de
   * l'appareil que Jellyfin a écrit dans son adresse). Seulement une séance que la route de démarrage a
   * ouverte en préchauffage pour **ce** compte, sous cet appareil (`prewarmSessions.ts`) : la clé
   * d'administration arrêterait sinon le transcodage de n'importe qui.
   */
  if (body?.prewarm === true) {
    const deviceId = typeof body?.deviceId === "string" ? body.deviceId : "";
    const safe = (v: string) => /^[A-Za-z0-9._-]{1,128}$/.test(v);
    if (!isJellyfinId(itemId) || !playSessionId || !safe(playSessionId) || !safe(deviceId)) {
      return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
    }
    if (!takePrewarmSession(session.jfId, playSessionId, deviceId)) {
      return NextResponse.json({ error: "Préchauffage inconnu" }, { status: 404 });
    }
    const ok = await jellyfin.stopTranscode(deviceId, playSessionId).then(
      () => true,
      () => false
    );
    return NextResponse.json({ stopped: ok }, { status: ok ? 200 : 502 });
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
