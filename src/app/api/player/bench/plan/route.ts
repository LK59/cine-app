import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { LOG_DIR } from "@/lib/logFile";
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

  const file = path.join(LOG_DIR, "player.log");
  const candidates = candidatesFrom(readLogLines([`${file}.1`, file]));
  return NextResponse.json({ candidates: candidates.slice(0, 40), suggested: suggest(candidates, 8) });
}
