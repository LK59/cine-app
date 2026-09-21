import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { withErrorHandling } from "@/lib/api-helpers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

/**
 * Les sessions Jellyfin en cours — pour l'administrateur seulement.
 *
 * Elles disent qui regarde quoi, sur quel appareil et depuis quelle adresse, pour tous les comptes.
 * La route était ouverte à toute session : `proxy.ts` ne filtre que les écritures, et une lecture
 * passe. Trouvé le 21/09/2026 en inventoriant ce que le cinéma pourrait reprendre de la gestion —
 * seules la page Jellyfin et la page Santé, toutes deux d'administration, s'en servent.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Réservé à l'administrateur" }, { status: 403 });
  }
  return withErrorHandling(() => jellyfin.getSessions());
}
