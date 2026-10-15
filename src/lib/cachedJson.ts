import { createHash } from "node:crypto";
import { brotliCompress, constants, gzipSync } from "node:zlib";
import { playlistEncodingFor } from "@/lib/playlistEncoding";

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
export interface Prepared {
  json: string;
  etag: string;
  gzip: Buffer;
  /** Le même corps en brotli, une fois calculé — voir `startBrotli`. */
  br?: Buffer;
  brStarted?: boolean;
}

/**
 * Brotli au niveau maximal, hors du fil principal (15/10/2026).
 *
 * Le catalogue des films : 1 Mo de JSON, 381 Ko en gzip, 297 Ko en brotli 11 (−22 %), retéléchargé
 * au moins une fois par jour (le classement du jour est dans la charge) — et c'est le plus gros
 * envoi de l'ouverture, en 4G à l'étranger. Mesuré sur le vrai catalogue : 1,7 s de calcul au
 * niveau 11, 94 ms au niveau 9 pour 320 Ko seulement. Le niveau 11 coûte donc trop pour une
 * réponse, mais rien une fois par version : il tourne dans le pool de libuv, et la réponse part en
 * gzip comme avant tant qu'il n'a pas fini. Une charge sous 1 Kio ne vaut pas la peine.
 */
const BROTLI_MIN_BYTES = 1024;

function startBrotli(p: Prepared): void {
  if (p.brStarted || p.json.length < BROTLI_MIN_BYTES) return;
  p.brStarted = true;
  try {
    brotliCompress(
      p.json,
      {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(p.json),
        },
      },
      (err, out) => {
        // Un échec laisse gzip, comme avant ; rien à journaliser pour une économie manquée.
        if (!err) p.br = out;
      }
    );
  } catch {
    /* idem */
  }
}

const prepared = new Map<string, Prepared>();

/** Pour les tests : combien de réponses préparées sont gardées. */
export function preparedCount(): number {
  return prepared.size;
}

/** La réponse préparée d'une charge utile — partagée avec la copie de secours du catalogue (§92). */
export function preparedJson(key: string, payload: unknown): Prepared {
  return prepare(key, JSON.stringify(payload));
}

function prepare(key: string, json: string): Prepared {
  const cached = prepared.get(key);
  if (cached && cached.json === json) return cached;
  const fresh = prepareUnkept(json);
  prepared.set(key, fresh);
  return fresh;
}

/**
 * Une réponse préparée **sans être gardée** : pour une charge utile propre à un compte et rare — la
 * copie de secours du catalogue pendant une panne (§92). Gardée sous une clé par compte, langue et
 * sorte, chacune restait dans `prepared` jusqu'au redémarrage (relecture du 14/10/2026).
 */
export function preparedUnkept(payload: unknown): Prepared {
  return prepareUnkept(JSON.stringify(payload));
}

function prepareUnkept(json: string): Prepared {
  const etag = `W/"${createHash("sha1").update(json).digest("base64url")}"`;
  return { json, etag, gzip: gzipSync(json) };
}

export function cachedJson(req: Request, key: string, payload: unknown): Response {
  return respondPrepared(req, prepare(key, JSON.stringify(payload)));
}

/** Répondre une charge utile déjà préparée : étiquette, 304, compression. */
export function respondPrepared(req: Request, p: Prepared): Response {
  const { json, etag, gzip } = p;

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

  const acceptEncoding = req.headers.get("accept-encoding");
  if (playlistEncodingFor(acceptEncoding) === "br") {
    if (p.br) {
      return new Response(new Uint8Array(p.br), {
        headers: { ...headers, "Content-Encoding": "br", "Content-Length": String(p.br.byteLength) },
      });
    }
    startBrotli(p);
  }

  if ((acceptEncoding ?? "").includes("gzip")) {
    return new Response(new Uint8Array(gzip), {
      headers: { ...headers, "Content-Encoding": "gzip", "Content-Length": String(gzip.byteLength) },
    });
  }
  return new Response(json, { headers });
}
