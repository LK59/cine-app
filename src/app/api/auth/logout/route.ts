import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { sessionDb } from "@/lib/db";

/**
 * Se déconnecter.
 *
 * Le jeton est vérifié — signature et expiration — avant qu'on n'agisse sur son identifiant.
 * Il l'était décodé sans l'être, sur la foi d'un commentaire disant qu'il fallait pouvoir lire le
 * `jti` même après suppression de la ligne en base : c'est exactement ce que fait déjà
 * `verifySessionToken`, qui ne consulte pas la base. Sans cette vérification, n'importe qui
 * connaissant un `jti` pouvait déconnecter la personne à qui il appartient.
 *
 * Ce qui est révoqué, c'est la session Cine App et rien d'autre : le jeton Jellyfin qu'elle
 * portait n'est pas fermé chez Jellyfin. C'est un choix — se déconnecter d'ici ne doit pas
 * ressembler, de près ou de loin, à perdre l'accès à Jellyfin. Le risque que ça laissait ouvert
 * — un cookie volé valant un jeton Jellyfin utilisable — est traité ailleurs et autrement : ce
 * jeton est désormais chiffré dans le cookie, et n'y est donc plus lisible.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const payload = await verifySessionToken(token);
  if (payload?.jti) sessionDb.delete(payload.jti);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
