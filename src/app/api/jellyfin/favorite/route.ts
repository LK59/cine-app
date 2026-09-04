import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { invalidateKey } from "@/lib/server-cache";

/**
 * Marquer un titre comme favori — chez Jellyfin, jamais en base locale.
 *
 * C'est le même principe que « vu » : chaque liste est stockée là où vit sa vérité. Les favoris
 * appartiennent au compte Jellyfin, donc ils suivent la personne dans ses applications, et il
 * n'existe pas deux versions de la même information susceptibles de diverger.
 */

// Le cache de la bibliothèque de cette personne porte `UserData`, donc « vu » et « favori » : le
// laisser tel quel ferait mentir « Ma liste » pendant les deux minutes de son TTL, juste après le
// geste qui l'a changée. Deux clés, celles de cette personne seule.
function invalidateOwnLibrary(userId: string) {
  invalidateKey(`jf:movies:${userId}`);
  invalidateKey(`jf:series:${userId}`);
}

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
    invalidateOwnLibrary(session.jfId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur Jellyfin" }, { status: 502 });
  }
}
