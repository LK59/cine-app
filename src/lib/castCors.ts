/**
 * L'accès d'un récepteur Chromecast au flux, depuis un autre domaine — DECISIONS.md §64.
 *
 * Une Apple TV va chercher l'adresse elle-même, sans contrôle d'origine : AirPlay n'a jamais eu
 * besoin de ceci. Le récepteur de Google, lui, est une page web chargée depuis les serveurs de
 * Google, qui lit le manifeste, les segments et les sous-titres par `fetch` : sans
 * `Access-Control-Allow-Origin`, son navigateur jette chaque réponse et la diffusion échoue sans
 * rien dire de plus qu'un « chargement impossible ».
 *
 * Deux bornes, et chacune compte :
 *
 *   - **Seulement avec un laissez-passer valable** (`castPassFor`, `castPreflightFor`). Une lecture
 *     dans la page, avec son cookie, garde exactement ses en-têtes d'avant : rien de ce qui est
 *     servi à une session ne devient lisible depuis un autre site.
 *   - **`*` et jamais d'identifiants.** Le laissez-passer est dans l'adresse ; aucun cookie n'est
 *     accepté ni nécessaire, donc `Access-Control-Allow-Credentials` n'est jamais posé.
 */

/** Ce qu'une réponse servie à un laissez-passer ajoute à ses en-têtes. */
export const CAST_CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  // Le lecteur du récepteur lit la taille et la plage d'un fichier servi tel quel (lecture directe)
  // pour s'y déplacer : sans les exposer, il les voit absentes.
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

/** Pose les en-têtes CORS de diffusion sur une réponse — à n'appeler qu'avec un laissez-passer. */
export function withCastCors<T extends { headers: Headers }>(res: T): T {
  for (const [name, value] of Object.entries(CAST_CORS_HEADERS)) res.headers.set(name, value);
  return res;
}

/**
 * La réponse à la question préalable d'un récepteur : GET (et HEAD) autorisés, avec `Range`.
 *
 * Une réponse nue (204), gardée en cache dix minutes par le navigateur du récepteur : il en pose
 * une par adresse, et une diffusion en demande des centaines.
 */
export function castPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CAST_CORS_HEADERS,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range, Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}
