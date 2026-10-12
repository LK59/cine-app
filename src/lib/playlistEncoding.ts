import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

/**
 * Compresser une liste de lecture HLS (`.m3u8`) pour le client qui l'accepte.
 *
 * Relevé le 12/10/2026 : une spectatrice sur Edge, connexion à ~40 Ko/s, n'a jamais vu d'image du
 * lecteur serveur — hls.js a téléchargé `main.m3u8`, **954 782 octets non compressés**, plusieurs
 * fois, et n'a jamais demandé un seul segment. Jellyfin recopie toute la requête (codecs, profils,
 * `TranscodeReasons`…) dans chaque ligne de segment, et le relais y ajoute le laissez-passer
 * (`withCastPass`) : ~1,1 Ko par segment de 3 s, 920 Ko pour un épisode de 41 min, 5,6 Mo pour
 * *Kill Bill* (253 min). Des lignes presque identiques, que la compression ramène à presque rien :
 * mesuré sur les vraies listes, l'épisode passe à 10 Ko en gzip et 4 Ko en brotli, *Kill Bill* à
 * 56 Ko et 19 Ko.
 *
 * Pourquoi personne ne compressait : Next compresse bien ses réponses (`compress: true`), mais son
 * module `compression` ne touche qu'aux types que mime-db dit compressibles, et
 * `application/vnd.apple.mpegurl` n'y est pas marqué. Le relais inverse est partagé avec d'autres
 * sites : on ne le touche pas. C'est donc la route qui compresse, comme `cachedJson` pour le
 * catalogue — et `compression` laisse passer une réponse qui porte déjà son `Content-Encoding`.
 *
 * Le contenu n'est jamais changé : une fois décompressé, c'est la liste d'avant, octet pour octet.
 * Les segments, eux, ne passent pas par ici (de la vidéo déjà compressée, et un flux continu).
 */

export type PlaylistEncoding = "br" | "gzip";

/** En dessous, l'en-tête gzip et l'aller-retour coûtent plus qu'ils ne rapportent (un maître : ~1,5 Ko). */
const MIN_BYTES = 1024;

/**
 * Brotli au niveau 4 : sur la liste de *Kill Bill* (5,6 Mo), 14 ms et 19 Ko, contre 56 Ko pour gzip
 * au niveau 6 en 18 ms. Le niveau 11 par défaut de Node y passerait des centaines de millisecondes.
 * Les deux tournent dans le pool de libuv : la boucle d'événements n'attend pas.
 */
const BROTLI_QUALITY = 4;

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * Ce que l'en-tête `Accept-Encoding` permet, brotli d'abord. Un codage refusé (`;q=0`) ne compte
 * pas, `*` vaut pour les deux ; sans en-tête, rien — la liste part telle qu'avant.
 */
export function playlistEncodingFor(acceptEncoding: string | null | undefined): PlaylistEncoding | null {
  if (!acceptEncoding) return null;
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    const q = params.map((p) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined);
    accepted.set(name, q === undefined ? 1 : Number(q));
  }
  const allows = (name: string) => {
    const q = accepted.get(name) ?? accepted.get("*");
    return q !== undefined && Number.isFinite(q) && q > 0;
  };
  if (allows("br")) return "br";
  if (allows("gzip")) return "gzip";
  return null;
}

/**
 * Le corps à envoyer et les en-têtes qui vont avec : `Content-Encoding` et `Content-Length` du corps
 * compressé, et toujours `Vary: Accept-Encoding` — la réponse dépend de l'en-tête, même quand elle
 * part en clair, et aucun cache ne doit servir l'une à qui a demandé l'autre.
 */
export async function encodePlaylist(
  body: Buffer,
  acceptEncoding: string | null | undefined
): Promise<{ body: Buffer; headers: Record<string, string> }> {
  const encoding = body.length >= MIN_BYTES ? playlistEncodingFor(acceptEncoding) : null;
  if (encoding) {
    try {
      const compressed =
        encoding === "br"
          ? await brotliAsync(body, {
              params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: body.length },
            })
          : await gzipAsync(body);
      return {
        body: compressed,
        headers: { "Content-Encoding": encoding, "Content-Length": String(compressed.length), Vary: "Accept-Encoding" },
      };
    } catch {
      // Une compression qui échoue ne doit pas devenir l'erreur : la liste part en clair, comme avant.
    }
  }
  return { body, headers: { "Content-Length": String(body.length), Vary: "Accept-Encoding" } };
}
