import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { NewsTranslationError, translateNews } from "@/lib/news/translate";
import { isEmptyContent, sanitizeContent } from "@/lib/news/content";
import { logError } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * « Traduire » : le français de l'éditeur vers en/es/de, en un appel au fournisseur d'IA des
 * sous-titres générés (DECISIONS.md §73). Rien n'est enregistré : l'éditeur reçoit les trois langues
 * et l'administrateur les relit avant d'enregistrer. Sans clé : 409, et la saisie reste manuelle.
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { fr?: unknown } | null;
  const fr = sanitizeContent(body?.fr);
  if (isEmptyContent(fr)) return NextResponse.json({ error: "Rien à traduire" }, { status: 400 });
  try {
    return NextResponse.json(await translateNews(fr, req.signal));
  } catch (error) {
    if (error instanceof NewsTranslationError) {
      if (error.kind === "unavailable") return NextResponse.json({ error: "Aucun fournisseur d'IA configuré" }, { status: 409 });
      logError("news-translate", error, { user: session.u });
      return NextResponse.json({ error: error.kind === "shape" ? "Traduction incomplète, réessayez" : "Le fournisseur n'a pas répondu" }, { status: 502 });
    }
    logError("news-translate", error, { user: session.u });
    return NextResponse.json({ error: "Traduction impossible" }, { status: 500 });
  }
}
