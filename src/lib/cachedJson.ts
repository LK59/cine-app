import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * Répondre en JSON sans renvoyer ce que le navigateur a déjà.
 *
 * Le catalogue fait 1,4 Mo, et chaque retour sur l'onglet le redemandait en entier. Deux
 * mécanismes du protocole suffisent à régler ça sans rien changer côté client :
 *
 *  * une **étiquette** (`ETag`) calculée sur la réponse, et `Cache-Control: private, no-cache`,
 *    qui veut dire « garde-la, mais demande-moi toujours si elle a changé ». Le navigateur
 *    redemande donc à chaque fois — c'est ce qu'on veut, la bibliothèque bouge — mais avec
 *    `If-None-Match`, et une réponse inchangée coûte alors un « 304 » de quelques octets au lieu
 *    d'un mégaoctet et demi. `fetch` s'en charge tout seul : le corps mis en cache lui revient
 *    comme si le serveur l'avait renvoyé.
 *  * la **compression**, que rien ne faisait ici — vérifié : même en la réclamant, la réponse
 *    arrivait entière. Sur du JSON, elle divise par cinq ou six.
 *
 * Le corps compressé et son étiquette sont gardés tant que la charge utile ne change pas :
 * recompresser un mégaoctet et demi à chaque requête pour un contenu identique coûterait plus
 * cher que ce qu'on économise.
 */
interface Prepared {
  json: string;
  etag: string;
  gzip: Buffer;
}

const prepared = new Map<string, Prepared>();

function prepare(key: string, json: string): Prepared {
  const cached = prepared.get(key);
  if (cached && cached.json === json) return cached;
  const etag = `W/"${createHash("sha1").update(json).digest("base64url")}"`;
  const fresh: Prepared = { json, etag, gzip: gzipSync(json) };
  prepared.set(key, fresh);
  return fresh;
}

export function cachedJson(req: Request, key: string, payload: unknown): Response {
  const { json, etag, gzip } = prepare(key, JSON.stringify(payload));

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ETag: etag,
    // `private` : ces réponses sont propres à la personne connectée et n'ont rien à faire dans
    // un cache partagé. `no-cache` n'interdit pas de garder, il impose de vérifier.
    "Cache-Control": "private, no-cache",
    // Le corps dépend de l'encodage accepté : sans ça, un cache pourrait servir la version
    // compressée à un client qui ne la comprend pas.
    Vary: "Accept-Encoding",
  };

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  if ((req.headers.get("accept-encoding") ?? "").includes("gzip")) {
    return new Response(new Uint8Array(gzip), {
      headers: { ...headers, "Content-Encoding": "gzip", "Content-Length": String(gzip.byteLength) },
    });
  }
  return new Response(json, { headers });
}
