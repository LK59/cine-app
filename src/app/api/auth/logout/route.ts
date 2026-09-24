import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { sessionDb } from "@/lib/db";
import { revokeJellyfinDevices, revokeJellyfinToken } from "@/lib/jellyfinRevoke";
import { forgetBeat } from "@/lib/activity/presence";
import { logAuthEvent } from "@/lib/eventLogs";
import { deviceLabel } from "@/lib/deviceLabel";
import { getClientIp } from "@/lib/api-helpers";

/**
 * Se déconnecter.
 *
 * Le jeton est vérifié — signature et expiration — avant qu'on n'agisse sur son identifiant.
 * Il l'était décodé sans l'être, sur la foi d'un commentaire disant qu'il fallait pouvoir lire le
 * `jti` même après suppression de la ligne en base : c'est exactement ce que fait déjà
 * `verifySessionToken`, qui ne consulte pas la base. Sans cette vérification, n'importe qui
 * connaissant un `jti` pouvait déconnecter la personne à qui il appartient.
 *
 * La session de l'application se ferme, et le jeton Jellyfin que cette connexion avait obtenu est
 * révoqué avec elle (24/09/2026, à la demande de l'administrateur) : il restait valide pour
 * toujours, et les jetons s'accumulaient — vingt-quatre pour un seul compte. Seul celui de cette
 * connexion tombe : les autres applications de la personne gardent les leurs. Par l'appareil
 * gardé avec la session quand on le connaît ; sinon, pour une session ouverte avant qu'on le
 * garde, par le jeton lui-même, que le cookie porte. Sans attendre Jellyfin : une déconnexion ne
 * doit jamais échouer parce qu'un autre serveur est lent.
 *
 * « Déconnecter tous les autres » (`/api/auth/sessions`) ne fait, lui, que fermer les sessions de
 * l'application — voir la route.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const payload = await verifySessionToken(token);
  if (payload?.jti) {
    const device = sessionDb.delete(payload.jti);
    forgetBeat(payload.jti);
    if (device) void revokeJellyfinDevices([device], "déconnexion");
    else void revokeJellyfinToken(payload.jfToken, "déconnexion");
    logAuthEvent("logout", { user: payload.jfUser ?? payload.u, ip: getClientIp(req), device: deviceLabel(req.headers.get("user-agent")) });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
