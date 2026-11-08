import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { localeOf } from "@/lib/i18n";
import { recapDb } from "@/lib/db";
import { readyRecapsFor, recapAvailable } from "@/lib/recap/service";
import { logError } from "@/lib/logger";

export interface CinemaRecap {
  text: string;
  /** L'épisode où le compte en est (« S02E05 ») — le texte vaut pour cet endroit-là. */
  episode: string;
}

/**
 * Les « Précédemment » prêts pour ce compte (DECISIONS.md §137), par identifiant Jellyfin de série.
 *
 * Une requête pour toutes les fiches, faite à l'ouverture et au retour au premier plan : le texte est
 * préparé pendant l'absence, il doit être là quand la fiche s'ouvre. Ne prépare rien elle-même — elle
 * note seulement que le compte est venu, et dans quelle langue, pour que la tâche de fond s'occupe de
 * lui. Une panne n'est pas grave ici : la fiche garde son résumé, la réponse est vide.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId || !recapAvailable()) return NextResponse.json({ recaps: {} });
  const locale = localeOf(req);
  try {
    recapDb.noteAccount(session.jfId, session.jfUser ?? session.u, locale);
    const recaps: Record<string, CinemaRecap> = await readyRecapsFor(session.jfId, locale);
    return NextResponse.json({ recaps }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    logError("recap", err);
    return NextResponse.json({ recaps: {} });
  }
}
