import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { shareRefusal } from "@/lib/share/guard";
import { jellyfin } from "@/lib/clients/jellyfin";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { isLanguageCode, recordSeriesLanguageChoice } from "@/lib/seriesLanguage";

/**
 * Un changement de langue du son fait à la main, signalé par le lecteur (`seriesLanguage.ts`).
 *
 * Le compte vient de la session et la série de Jellyfin, jamais du corps : seuls l'épisode et la
 * langue choisie sont reçus. Un élément qui n'est pas un épisode ne retient rien — un film n'a pas
 * de suite à ouvrir dans cette langue.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.u || !session.jfId) return new NextResponse(null, { status: 403 });

  const body = (await req.json().catch(() => null)) as { itemId?: unknown; language?: unknown } | null;
  const itemId = body?.itemId;
  const language = typeof body?.language === "string" ? body.language.toLowerCase() : null;
  if (typeof itemId !== "string" || !isJellyfinId(itemId) || !isLanguageCode(language)) {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }
  const shareRefused = await shareRefusal(session, itemId);
  if (shareRefused) return shareRefused;

  const item = await jellyfin.getItemUserData(session.jfId, itemId).catch(() => null);
  if (!item) return NextResponse.json({ error: "Élément introuvable" }, { status: 404 });
  if (item.Type !== "Episode" || !item.SeriesId) return NextResponse.json({ ok: true, series: false });

  const state = recordSeriesLanguageChoice(session.u, item.SeriesId, itemId, language);
  return NextResponse.json({ ok: true, series: true, preferred: state.preferred });
}
