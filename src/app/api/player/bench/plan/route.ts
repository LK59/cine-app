import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { recentPlayerLogFiles } from "@/lib/playerLog";
import { candidatesFrom, readLogLines, suggest } from "@/lib/playerBench/plan";

/**
 * Les films que le banc d'essai propose — tirés du journal du lecteur.
 *
 * Réservé à l'administrateur, et vérifié ici plutôt que laissé au proxy : c'est une lecture, et le
 * proxy laisse lire tout le monde. Or ce qu'elle rend est l'historique de visionnage de chacun.
 */
export async function GET(req: NextRequest) {
  if (!config.player.enabled) return new NextResponse(null, { status: 404 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (session?.role !== "admin") return new NextResponse(null, { status: 403 });

  // Toutes les archives, et les spectateurs seulement : les lignes du banc vont dans
  // `bench-player.log`, et un banc qui choisirait ses films d'après ses propres blocages ne
  // ferait que se répéter (`candidatesFrom` écarte en plus celles d'avant la séparation).
  const candidates = candidatesFrom(readLogLines(recentPlayerLogFiles()));
  return NextResponse.json({ candidates: candidates.slice(0, 40), suggested: suggest(candidates, 8) });
}
