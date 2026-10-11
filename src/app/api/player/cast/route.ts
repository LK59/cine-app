import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";

/**
 * Ce que la page doit savoir pour proposer le Chromecast — DECISIONS.md §64.
 *
 * - `allowed` : ce compte voit-il le bouton ? Les administrateurs toujours, les autres quand
 *   l'installation l'a ouvert à tous (`CHROMECAST_FOR_EVERYONE`). Décidé ici, avec le rôle de la
 *   session, plutôt que dans la page.
 * - `receiverAppId` : l'application que le Chromecast ouvre (réglage de l'application → `.env` →
 *   le récepteur public de Google). Pas un secret.
 *
 * À part de `/api/config/public`, dont la réponse est gardée sur l'appareil et dont le format est
 * suivi (`PERSISTED_CACHE_SCHEMA`) : celle-ci n'est demandée que par un navigateur qui sait émettre,
 * au moment où un lecteur s'ouvre. Relue à chaque appel : un réglage changé vaut au film suivant.
 */
export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    {
      allowed: session.role === "admin" || config.player.chromecastForEveryone,
      receiverAppId: config.player.castReceiverAppId,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
