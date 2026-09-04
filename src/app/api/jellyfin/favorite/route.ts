import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

/**
 * Marquer un titre comme favori — chez Jellyfin, jamais en base locale.
 *
 * C'est le même principe que « vu » : chaque liste est stockée là où vit sa vérité. Les favoris
 * appartiennent au compte Jellyfin, donc ils suivent la personne dans ses applications, et il
 * n'existe pas deux versions de la même information susceptibles de diverger.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId) {
    return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const itemId = body?.itemId as string | undefined;
  const favorite = body?.favorite as boolean | undefined;
  if (!itemId || typeof favorite !== "boolean") {
    return NextResponse.json({ error: "Paramètres invalides" }, { status: 400 });
  }

  try {
    if (favorite) await jellyfin.markFavorite(session.jfId, itemId);
    else await jellyfin.unmarkFavorite(session.jfId, itemId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur Jellyfin" }, { status: 502 });
  }
}
