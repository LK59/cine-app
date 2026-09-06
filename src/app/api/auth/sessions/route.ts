import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { sessionDb } from "@/lib/db";
import { revokeJellyfinToken } from "@/lib/clients/jellyfin";

async function getSession(req: NextRequest) {
  return verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
}

function userId(session: { jfId?: string; u: string }) {
  return session.jfId ?? session.u;
}

export interface OtherSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Les autres connexions ouvertes sur ce compte.
 *
 * Un simple compte ne dit rien : « 3 » ne permet ni de reconnaître une session oubliée sur un
 * ordinateur prêté, ni de constater qu'il n'y a rien d'anormal. Les dates, elles, le permettent —
 * et elles étaient déjà en base.
 */
export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const others = sessionDb.listOthers(userId(session), session.jti);
  return NextResponse.json({
    count: others.length,
    // Jamais le `jti` : c'est lui qui identifie une session, et une page n'a besoin que de la
    // reconnaître, pas de la nommer.
    sessions: others.map((s, i): OtherSession => ({ id: String(i), createdAt: s.createdAt, lastSeenAt: s.lastSeenAt })),
  });
}

/**
 * Fermer toutes les autres.
 *
 * Chaque session emporte avec elle la session Jellyfin ouverte pour elle. Sans ça, la révocation
 * n'effaçait qu'une ligne ici : le jeton Jellyfin que ce cookie transportait restait valide, et
 * quiconque détenait le cookie gardait un accès à Jellyfin après avoir été « déconnecté ».
 */
export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const others = sessionDb.listOthers(userId(session), session.jti);
  await Promise.all(others.map((other) => revokeJellyfinToken(other.jfToken)));
  const revoked = sessionDb.deleteOthers(userId(session), session.jti);
  return NextResponse.json({ ok: true, revoked });
}
