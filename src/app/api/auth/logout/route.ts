import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { sessionDb } from "@/lib/db";
import { revokeJellyfinToken } from "@/lib/clients/jellyfin";

/**
 * Se déconnecter.
 *
 * Le jeton est vérifié — signature et expiration — avant qu'on n'agisse sur son identifiant.
 * Il l'était décodé sans l'être, sur la foi d'un commentaire disant qu'il fallait pouvoir lire le
 * `jti` même après suppression de la ligne en base : c'est exactement ce que fait déjà
 * `verifySessionToken`, qui ne consulte pas la base. Sans cette vérification, n'importe qui
 * connaissant un `jti` pouvait déconnecter la personne à qui il appartient.
 *
 * La session Jellyfin ouverte pour cette connexion est fermée dans la foulée : la révoquer ici
 * est la seule occasion de le faire, et un jeton laissé vivant chez Jellyfin est un jeton qui
 * survit à la déconnexion. Voir `revokeJellyfinToken` pour pourquoi les autres appareils de la
 * personne n'en sont pas affectés.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const payload = await verifySessionToken(token);
  if (payload?.jti) {
    // Celui de la base plutôt que celui du cookie : c'est le même, mais la base reste lisible
    // même si le cookie a été émis par une version qui ne le chiffrait pas encore.
    await revokeJellyfinToken(sessionDb.jellyfinToken(payload.jti) ?? payload.jfToken);
    sessionDb.delete(payload.jti);
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
