import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { quizDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Les statistiques de « Devine le film » (DECISIONS.md §146), pour le menu du chalet (Échap → Statistiques) : les
 * chiffres du compte par variante, et le classement de la maison (meilleur score de chaque compte).
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const headers = { "Cache-Control": "private, no-store" };
  if (session.role === "share") return NextResponse.json({ mine: [], board: [] }, { headers });
  const me = session.jfId ?? `local:${session.u}`;
  const board = quizDb.board(10).map(({ account, name, best, games }) => ({ name, best, games, you: account === me }));
  return NextResponse.json({ mine: quizDb.mine(me), board }, { headers });
}
