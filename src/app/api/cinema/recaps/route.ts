import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { readyRecapsFor, recapAvailable, type RecapForSheet } from "@/lib/recap/service";
import { logError } from "@/lib/logger";

export type CinemaRecap = RecapForSheet;

/**
 * Les « Précédemment » prêts pour ce compte (DECISIONS.md §137), par identifiant Jellyfin de série.
 *
 * Une requête pour toutes les fiches, faite à l'ouverture et au retour au premier plan. Ne prépare
 * rien : la tâche de fond s'en charge pour tous les comptes, dans la langue que chacun a choisie
 * (`user_preferences`). Rien pour un compte qui a coupé l'option. Une panne n'est pas grave ici : la
 * fiche garde son synopsis, la réponse est vide.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId || session.role === "share" || !recapAvailable()) return NextResponse.json({ recaps: {} });
  try {
    const recaps: Record<string, CinemaRecap> = await readyRecapsFor(session.jfId);
    return NextResponse.json({ recaps }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    logError("recap", err);
    return NextResponse.json({ recaps: {} });
  }
}
