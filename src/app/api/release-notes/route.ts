import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { newsFor } from "@/lib/news/store";

/**
 * Les Nouveautés du compte connecté (DECISIONS.md §73) : les pages publiées et celles qui lui
 * restent à voir. Un premier passage crée sa ligne, juste sous la dernière page publiée.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  return NextResponse.json(newsFor(session.u), { headers: { "Cache-Control": "no-store" } });
}
