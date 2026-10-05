import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { resolveJellyseerrIdentity } from "@/lib/jellyseerrIdentity";
import { withErrorHandling } from "@/lib/api-helpers";
import { config } from "@/lib/config";
import { cancelRequest } from "@/lib/requestCancel";

export const dynamic = "force-dynamic";

/**
 * Annuler une demande — la règle et ses garde-fous sont dans `cancelRequest` (DECISIONS.md §49) :
 * chacun retire la sienne, quel que soit son état ; restée sans suite, elle sort aussi de Radarr ou
 * Sonarr ; en cours ou déjà là, seule la demande disparaît.
 *
 * Avant le 05/10/2026, l'appel partait avec le cookie Jellyseerr de la personne, et Jellyseerr ne
 * laisse un compte ordinaire retirer que ses demandes en attente : avec l'approbation automatique,
 * la croix échouait partout. La propriété est vérifiée ici, et le retrait fait avec la clé.
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

  const identity = await resolveJellyseerrIdentity(session);
  // La demande de quelqu'un d'autre, ou inexistante : la même réponse, sans ligne d'erreur — ce n'est
  // pas une panne, et rien ne doit dire si ce numéro existe.
  let notFound = false;
  const response = await withErrorHandling(async () => {
    const outcome = await cancelRequest(id, { userId: identity.userId ?? null, admin: session.role === "admin" });
    notFound = !outcome.ok;
    return outcome;
  }, "player-request-cancel");
  return notFound ? NextResponse.json({ error: "Demande introuvable" }, { status: 404 }) : response;
}
