import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { ackPassageArrival, passageArrival } from "@/lib/passage/service";

/**
 * Les réglages qu'un passage a emportés (DECISIONS.md §119), pour la session qui en est issue.
 *
 * `GET` : `{ at, settings }`, ou `{}` — lu au lancement du cinéma sur la nouvelle adresse, application
 * installée comprise : c'est là, et pas seulement dans la page `/passage`, que l'appareil les pose
 * (une application installée sur iPhone a son propre stockage). `POST { installed }` : posés ; dans
 * l'application installée, ils sont effacés.
 */
async function sessionOf(req: NextRequest) {
  return verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
}

export async function GET(req: NextRequest) {
  const session = await sessionOf(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const arrival = passageArrival(session.jti);
  return NextResponse.json(arrival ?? {}, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const session = await sessionOf(req);
  if (!session) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { installed?: unknown } | null;
  ackPassageArrival(session.jti, body?.installed === true);
  return NextResponse.json({ ok: true });
}
