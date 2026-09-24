import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { accountDetail } from "@/lib/activity/accounts";
import { sessionDb } from "@/lib/db";
import { jellyfin } from "@/lib/clients/jellyfin";
import { forgetBeat } from "@/lib/activity/presence";
import { forgetJellyfinToken } from "@/lib/jellyfinToken";
import { revokeJellyfinDevices } from "@/lib/jellyfinRevoke";
import { logAdminAction } from "@/lib/logger";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Tout ce qu'on sait d'un compte. */
export async function GET(req: NextRequest, { params }: Params) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const { id } = await params;
  const detail = await accountDetail(id);
  if (!detail) return NextResponse.json({ error: "Compte inconnu" }, { status: 404 });
  return NextResponse.json({ now: Date.now(), ...detail });
}

/**
 * Les actions explicites sur un compte — jamais une connexion à sa place.
 *  - `closeSessions` : toutes ses sessions, ou une seule (`jti`) ; il devra se reconnecter.
 *  - `markPlayed` / `markUnplayed` : l'état « vu » d'un titre.
 *  - `setPosition` : où il en est d'un titre, en secondes ; 0 le retire de « Reprendre ».
 * Chacune est écrite au journal du serveur (`scope: "admin"`).
 */
export async function POST(req: NextRequest, { params }: Params) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as
    | { action?: string; jti?: string; itemId?: string; seconds?: number }
    | null;
  const users = await jellyfin.getUsers().catch(() => []);
  const user = users.find((u) => u.Id === id);
  if (!user) return NextResponse.json({ error: "Compte inconnu" }, { status: 404 });
  const admin = session.jfUser ?? session.u;
  const itemId = typeof body?.itemId === "string" && /^[0-9a-f-]{16,64}$/i.test(body.itemId) ? body.itemId : null;

  try {
    switch (body?.action) {
      case "closeSessions": {
        // Une déconnexion complète, imposée : le jeton Jellyfin de chaque connexion fermée est
        // révoqué avec elle (`jellyfinRevoke.ts`) — il devra se reconnecter.
        const mine = sessionDb.listForUser(id).map((s) => s.jti);
        const closed = body.jti
          ? mine.includes(body.jti)
            ? [{ jti: body.jti, jfDevice: sessionDb.delete(body.jti) }]
            : []
          : sessionDb.deleteForUser(id);
        for (const { jti } of closed) {
          forgetBeat(jti);
          forgetJellyfinToken(jti);
        }
        await revokeJellyfinDevices(closed.map((c) => c.jfDevice), "fermée par l'administrateur");
        logAdminAction(admin, "sessions fermées", { account: user.Name, count: closed.length });
        return NextResponse.json({ ok: true, closed: closed.length });
      }
      case "markPlayed":
      case "markUnplayed": {
        if (!itemId) return NextResponse.json({ error: "Titre manquant" }, { status: 400 });
        await (body.action === "markPlayed" ? jellyfin.markPlayed(id, itemId) : jellyfin.markUnplayed(id, itemId));
        logAdminAction(admin, body.action === "markPlayed" ? "marqué vu" : "marqué non vu", { account: user.Name, itemId });
        return NextResponse.json({ ok: true });
      }
      case "setPosition": {
        const seconds = Number(body.seconds);
        if (!itemId || !Number.isFinite(seconds) || seconds < 0) {
          return NextResponse.json({ error: "Position invalide" }, { status: 400 });
        }
        if (seconds === 0) await jellyfin.resetPlaybackPosition(id, itemId);
        else await jellyfin.savePositionAsAdmin(id, itemId, Math.round(seconds * 1e7));
        logAdminAction(admin, "position corrigée", { account: user.Name, itemId, seconds });
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Échec" }, { status: 502 });
  }
}
