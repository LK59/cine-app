import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { newsDb } from "@/lib/news/store";
import { newsSeenAllowed } from "@/lib/writeLimits";

/**
 * « La fenêtre des Nouveautés vient de s'afficher » (DECISIONS.md §73) : le drapeau du compte
 * s'éteint là, à l'affichage, et non à la fermeture — une page fermée par le système, un onglet
 * tué, comptent comme vus. N'écrit que pour l'appelant.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  if (!newsSeenAllowed(session.u)) return new NextResponse(null, { status: 429 });
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? body.ids.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 50) : [];
  if (ids.length === 0) return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
  newsDb.markSeen(session.u, ids);
  return new NextResponse(null, { status: 204 });
}
