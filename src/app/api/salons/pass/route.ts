import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { audienceAllows } from "@/lib/featureAudience";
import { SALONS_PASS_TTL_MS, signSalonsPass } from "@/lib/salons/pass";
import { publishSalonsRelay } from "@/lib/salons/relay";

export const dynamic = "force-dynamic";

/**
 * Un laissez-passer pour les salons du chalet (DECISIONS.md §146) — ce que le mode Immersion demande avant
 * d'ouvrir sa WebSocket (`/api/salons/ws`, relayée par `server-boot/salonsRelay.mjs`).
 *
 * Répond **toujours 200** à une session valable : `{ available: false }` quand le jeu à plusieurs n'est pas pour
 * elle (coupé, réservé aux administrateurs, service sans clé, lien de partage) — le chalet joue alors seul, jeux
 * compris. Jamais un 404 ou un 403 que le pare-feu du serveur compterait.
 *
 * Le laissez-passer vaut cinq minutes : de quoi ouvrir la connexion. Chaque (re)connexion en redemande un.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  // Le portail (`src/proxy.ts`) a déjà refusé une requête sans session, avec `x-session-expired` — il en est le seul
  // émetteur. Ceci ne couvre qu'une session révoquée entre lui et nous.
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const headers = { "Cache-Control": "private, no-store" };
  const { audience, url, key } = config.salons;
  if (session.role === "share" || !audienceAllows(audience, session) || key.length < 32) {
    publishSalonsRelay(null);
    return NextResponse.json({ available: false }, { headers });
  }
  publishSalonsRelay(url);
  const pass = signSalonsPass(
    {
      // L'identité Jellyfin quand elle existe ; le compte local de l'administrateur sinon.
      sub: session.jfId ?? `local:${session.u}`,
      name: (session.jfUser ?? session.u).slice(0, 64),
      admin: session.role === "admin",
      exp: Date.now() + SALONS_PASS_TTL_MS,
    },
    key
  );
  return NextResponse.json({ available: true, pass, socket: "/api/salons/ws" }, { headers });
}
