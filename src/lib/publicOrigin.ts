import type { NextRequest } from "next/server";

/**
 * L'adresse sous laquelle le monde extérieur joint cette application.
 *
 * Seul le mandataire inverse la connaît — `nextUrl.origin` ne voit que le conteneur —, et il la
 * transmet par `x-forwarded-proto` / `x-forwarded-host`. Une seule route en a besoin pour écrire
 * une adresse absolue : la diffusion (le téléviseur va chercher le flux lui-même). Lue à chaque
 * requête, jamais réglée : une installation servie sous deux adresses à la fois (un ancien nom
 * gardé à côté du nouveau) donne à chaque téléviseur celle par laquelle la page est venue.
 */
export function publicOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return `${proto}://${host}`;
}
