import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { sessionDb } from "@/lib/db";

async function getSession(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return verifySessionToken(token);
}

function userId(session: { jfId?: string; u: string }) {
  return session.jfId ?? session.u;
}

// GET /api/auth/sessions — count of other active sessions for this user
export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const count = sessionDb.countOthers(userId(session), session.jti);
  return NextResponse.json({ count });
}

// DELETE /api/auth/sessions — revoke all other sessions for this user
export async function DELETE(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const revoked = sessionDb.deleteOthers(userId(session), session.jti);
  return NextResponse.json({ ok: true, revoked });
}
