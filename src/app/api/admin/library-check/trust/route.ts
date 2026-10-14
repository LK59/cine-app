import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { episodeTextTrustDb } from "@/lib/libraryCheck/store";
import { isJellyfinOnlyId } from "@/lib/jellyfinOnlyId";

export const dynamic = "force-dynamic";

/**
 * « Faire confiance à Jellyfin pour les noms d'épisodes » (DECISIONS.md §89, §90) : posée ou retirée
 * pour une série Sonarr, par l'administrateur. La liste des épisodes la relit à chaque ouverture.
 *
 * Corps : `{ sonarrId, trusted, title? }`. Une série que Jellyfin a seule n'a pas d'identifiant Sonarr
 * (plage réservée) : elle a déjà le texte de Jellyfin.
 */
export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { sonarrId?: unknown; trusted?: unknown; title?: unknown } | null;
  const sonarrId = typeof body?.sonarrId === "number" ? body.sonarrId : NaN;
  if (!Number.isInteger(sonarrId) || sonarrId <= 0 || isJellyfinOnlyId(sonarrId) || typeof body?.trusted !== "boolean") {
    return NextResponse.json({ error: "Série ou valeur invalide" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.slice(0, 300) : null;
  episodeTextTrustDb.set(sonarrId, body.trusted, { title, by: session.u ?? null });
  return NextResponse.json({ sonarrId, trusted: body.trusted });
}
