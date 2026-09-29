import type { NextRequest } from "next/server";

/**
 * Une écriture envoyée par une autre page que la nôtre.
 *
 * Le cookie de session est `SameSite=Lax`, ce qui arrête un site tiers — mais pas un « même site » :
 * pour le navigateur, tous les sous-domaines du domaine qui héberge l'application en sont un, et le
 * cookie part avec leurs POST. Une page compromise sur n'importe lequel d'entre eux pouvait écrire
 * ici au nom de qui était connecté — un `text/plain` sur `/api/watchlist` passait (audit du
 * 26/09/2026).
 *
 * `Sec-Fetch-Site` d'abord : tout navigateur récent l'envoie, et c'est lui qui dit le vrai — `same-
 * origin` pour nos propres appels, `sendBeacon` et le service worker compris. `Origin` ensuite, pour
 * un navigateur qui ne l'enverrait pas. Sans l'un ni l'autre (un script, un test), rien n'est
 * refusé : ce n'est pas un navigateur qu'on pourrait abuser.
 *
 * Deux appelants, et une seule formulation : le proxy, et `reportCaller` (`reportRequest.ts`) pour
 * les signalements, que le proxy ne voit plus (A2, 29/09/2026 — voir `HORS_PROXY` dans proxy.ts).
 */
export function crossSiteWrite(req: NextRequest): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return false;
  if (!req.nextUrl.pathname.startsWith("/api/") || !req.headers) return false;
  const site = req.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.get("host");
  } catch {
    return true;
  }
}
