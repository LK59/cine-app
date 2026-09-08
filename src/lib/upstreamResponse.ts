import { NextResponse } from "next/server";
import { UpstreamUnreachableError, UPSTREAM_UNREACHABLE } from "@/lib/http";
import { logError } from "@/lib/logger";

/**
 * L'échec d'une route qui ne peut pas se rabattre sur autre chose.
 *
 * `withErrorHandling` enveloppe la réponse *et* le succès, ce qui ne convient pas aux routes du
 * catalogue : elles répondent par `cachedJson`, avec une étiquette et une compression que cette
 * enveloppe ne connaît pas. Elles n'avaient donc aucune gestion d'erreur du tout — et une panne
 * de Jellyfin sortait en 500 nu, c'est-à-dire en « Erreur 500 » à l'écran, sur une grille par
 * ailleurs vide.
 *
 * Observé pendant la migration : la gestion encaissait la panne service par service et restait
 * lisible, le cinéma tombait en entier. Ici, la réponse porte le même code que partout ailleurs,
 * pour que l'écran dise ce qui manque plutôt que le numéro de son échec.
 */
export function upstreamFailure(err: unknown, scope: string): NextResponse {
  const message = err instanceof Error ? err.message : "Unknown error";
  logError(scope, err);
  if (err instanceof UpstreamUnreachableError) {
    return NextResponse.json({ error: message, code: UPSTREAM_UNREACHABLE }, { status: 502 });
  }
  return NextResponse.json({ error: message }, { status: 502 });
}
