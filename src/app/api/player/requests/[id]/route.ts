import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { jellyseerr } from "@/lib/clients/jellyseerr";
import { withErrorHandling } from "@/lib/api-helpers";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Annuler une demande.
 *
 * Ce que ça fait : la demande disparaît de Jellyseerr, donc de la liste de la personne.
 * Ce que ça ne fait pas : toucher à Radarr ou Sonarr. Le titre reste surveillé et un
 * téléchargement déjà lancé continue — c'est un choix, pas un oubli. Le ménage côté gestion se
 * fait depuis le panneau prévu pour ça, où il est visible et réversible ; le faire d'ici
 * retirerait le titre pour tout le monde, y compris pour quelqu'un d'autre qui l'aurait demandé.
 *
 * L'appel part avec le cookie de session de la personne : Jellyseerr applique alors ses propres
 * droits, et refusera de lui-même la demande de quelqu'un d'autre.
 */
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  if (!config.jellyseerr.apiKey) {
    return NextResponse.json({ error: "Les demandes ne sont pas disponibles" }, { status: 503 });
  }

  const id = Number.parseInt((await props.params).id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "Demande introuvable" }, { status: 400 });
  }

  return withErrorHandling(async () => {
    await jellyseerr.deleteRequest(id, session.jsCookie);
    return { ok: true };
  }, "player-request-cancel");
}
