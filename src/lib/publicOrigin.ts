import type { NextRequest } from "next/server";
import { forwardedFromTrustedPeer } from "@/lib/trustedProxy";

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

/** Un nom d'hôte DNS, en minuscules : des étiquettes de lettres, chiffres et tirets. */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Le nom d'hôte par lequel cette requête est arrivée, pour le journal — l'ancienne ou la nouvelle
 * adresse d'une installation qui change de nom (DECISIONS.md §119, la ligne `ouverture` de
 * `startup.log`). Le même en-tête que `publicOrigin`, mais `X-Forwarded-Host` n'est cru que d'un
 * relais de confiance (`forwardedFromTrustedPeer`, la règle de l'adresse cliente) ; sinon `Host`.
 * Réduit au nom (ni port, ni schéma), en minuscules, validé ; `null` pour tout le reste — jamais
 * une valeur libre recopiée telle quelle.
 */
export function requestHost(headers: { get(name: string): string | null }, rawProxies?: string): string | null {
  const forwarded = forwardedFromTrustedPeer(headers, rawProxies) ? headers.get("x-forwarded-host") : null;
  // Un relais en chaîne peut écrire « a, b » : le premier est celui que le navigateur a demandé.
  const raw = (forwarded?.split(",")[0] ?? headers.get("host") ?? "").trim().toLowerCase();
  if (!raw || raw.length > 260 || raw.startsWith("[")) return null;
  const name = raw.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  return HOSTNAME.test(name) ? name : null;
}
