import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, type SessionPayload } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

/**
 * La page d'activité est à l'administrateur seul, lecture comprise : elle nomme ce que chacun a
 * regardé, quand, et sur quel appareil. `proxy.ts` ne refuse que les écritures d'un compte
 * ordinaire — une lecture passe —, d'où la vérification ici, dans chaque route.
 */
export async function adminOnly(req: NextRequest): Promise<SessionPayload | NextResponse> {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Réservé à l'administrateur" }, { status: 403 });
  }
  return session;
}
