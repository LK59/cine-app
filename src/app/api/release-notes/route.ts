import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { newsFor } from "@/lib/news/store";
import { cachedJson } from "@/lib/cachedJson";

/**
 * Les Nouveautés du compte connecté (DECISIONS.md §73) : les pages publiées et celles qui lui
 * restent à voir. Un premier passage crée sa ligne, juste sous la dernière page publiée.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  // Avec une étiquette plutôt que `no-store` (27/10/2026) : chaque ouverture redemandait toutes les
  // pages publiées — 81 Ko, à chaque lancement d'un iPhone, pour savoir s'il y avait du nouveau.
  // Le serveur recalcule à chaque requête et répond 304 tant que rien n'a changé pour ce compte : une
  // page vue, publiée ou relancée change la réponse, donc l'étiquette. Une entrée par compte.
  return cachedJson(req, `release-notes:${session.u}`, newsFor(session.u));
}
