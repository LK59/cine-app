import { ENCODING_MARKER, FRAMING_ENV, LENGTH_MARKER } from "../../server-boot/responseFraming.mjs";

/**
 * `Content-Encoding` et `Content-Length` d'une réponse de route, par le seul chemin que Next laisse
 * passer (06/11/2026, DECISIONS.md §131).
 *
 * Depuis 16.4.5, Next retire ces deux en-têtes de toute réponse de route (`send-response.js`,
 * `FORBIDDEN_HEADERS`) : un catalogue brotli partait sans son `Content-Encoding` et le navigateur le
 * lisait comme du JSON — toute l'application vide, le 05/11/2026. La route pose donc un marqueur, et
 * le serveur de démarrage (`server-boot/responseFraming.mjs`) en fait le vrai en-tête au moment où la
 * réponse part. Écrire `Content-Encoding` directement dans une route est une erreur :
 * `response-framing.test.ts` le refuse dans `src/app` et `src/lib`.
 *
 * Sans ce serveur — `next dev`, un test, un autre point d'entrée —, rien ne traduirait le marqueur :
 * `framingAvailable()` est faux, et les routes répondent alors **en clair** (la compression de Next
 * s'occupe du JSON) et sans longueur. Jamais un corps compressé sans son étiquette : c'est la panne
 * même. Le drapeau est lu à chaque appel, pas copié dans une constante du module.
 */
export function framingAvailable(): boolean {
  return process.env[FRAMING_ENV] === "1";
}

/** Les en-têtes d'un corps précompressé, tenu en mémoire. À n'appeler que si `framingAvailable()`. */
export function encodedBodyHeaders(encoding: "br" | "gzip", byteLength: number): Record<string, string> {
  return { [ENCODING_MARKER]: encoding, [LENGTH_MARKER]: String(byteLength) };
}

/**
 * La longueur d'un corps que la route tient : un tampon en mémoire, ou une plage de fichier lue par
 * `createReadStream({ start, end })`, qui ne rend jamais plus. Sans le serveur de démarrage, rien.
 */
export function lengthHeader(byteLength: number): Record<string, string> {
  if (!framingAvailable() || !Number.isSafeInteger(byteLength) || byteLength < 0) return {};
  return { [LENGTH_MARKER]: String(byteLength) };
}

/**
 * La longueur annoncée par un amont (Jellyfin) pour un corps relayé tel quel — seulement si ce corps
 * est bien les octets que l'amont a comptés.
 *
 * C'est le cas que GHSA-pc58 vise : `fetch` décompresse de lui-même un corps `Content-Encoding: gzip`
 * et garde l'en-tête `Content-Length` d'origine — recopiée, cette longueur ne décrit plus ce qui part.
 * Un amont qui a codé son corps (tout autre chose que `identity`) ne donne donc pas sa longueur ; un
 * `Content-Length` qui n'est pas un simple entier non plus. Le reste — un fichier vidéo, un téléchargement :
 * Jellyfin ne compresse pas ces types — garde la sienne, comme avant 16.4.5.
 */
export function upstreamLengthHeader(upstream: Response): Record<string, string> {
  const coding = upstream.headers.get("content-encoding");
  if (coding && coding.trim().toLowerCase() !== "identity") return {};
  const raw = upstream.headers.get("content-length");
  if (!raw || !/^\d{1,15}$/.test(raw.trim())) return {};
  return lengthHeader(Number(raw.trim()));
}
