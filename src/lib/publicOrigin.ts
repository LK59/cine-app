import type { NextRequest } from "next/server";

/**
 * L'adresse sous laquelle le monde extérieur joint cette application.
 *
 * Seul le mandataire inverse la connaît — `nextUrl.origin` ne voit que le conteneur —, et il la
 * transmet par `x-forwarded-proto` / `x-forwarded-host`. Deux routes en ont besoin pour écrire une
 * adresse absolue : la diffusion (le téléviseur va chercher le flux lui-même) et la page publique
 * de la galerie (les aperçus de lien exigent des images absolues). Cette seconde l'écrivait en
 * dur, avec le domaine de l'installation de référence : ailleurs, ses liens pointaient chez elle.
 */
export function publicOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return `${proto}://${host}`;
}
