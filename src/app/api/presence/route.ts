import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { recordBeat } from "@/lib/activity/presence";
import { deviceLabel } from "@/lib/deviceLabel";

/**
 * « Je suis là » — un signal par minute de chaque onglet ouvert, pour la vue en direct de
 * l'administrateur. Le compte vient de la session, jamais du corps : un signal ne peut parler que
 * de celui qui l'envoie. Le corps ne dit que deux choses — l'onglet est-il visible, et quel titre
 * est ouvert — et rien n'est renvoyé.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new NextResponse(null, { status: 401 });
  const body = (await req.json().catch(() => null)) as { visible?: unknown; itemId?: unknown; title?: unknown } | null;
  const itemId = typeof body?.itemId === "string" ? body.itemId.slice(0, 64) : null;
  const title = typeof body?.title === "string" ? body.title.slice(0, 200) : null;
  recordBeat(session.jti, {
    user: session.jfUser ?? session.u,
    jfId: session.jfId ?? null,
    at: Date.now(),
    visible: body?.visible !== false,
    playing: itemId ? { itemId, title: title ?? "" } : null,
    device: deviceLabel(req.headers.get("user-agent")),
  });
  return new NextResponse(null, { status: 204 });
}
