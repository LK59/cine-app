/**
 * Retirer d'une adresse de flux le jeton que Jellyfin y a écrit.
 *
 * Le `TranscodingUrl` que rend `PlaybackInfo` porte `ApiKey=<jeton de la personne>`, et le
 * manifeste maître recopie sa propre requête dans l'adresse de chaque variante, qui la recopie dans
 * chaque segment : le jeton passait par le navigateur, à chaque requête, et restait dans le journal
 * du relais inverse (relevé le 25/09/2026 : `master.m3u8?…&ApiKey=…`) — et, pour une diffusion,
 * sur le téléviseur. Jellyfin peut aussi écrire `api_key=` dans l'adresse d'une piste de
 * sous-titres HLS, avec le jeton de la requête, que le relais signe de la clé d'administration :
 * pas observé ici, retiré de la même façon, par précaution.
 *
 * Personne n'en a besoin : le relais (`/api/jellyfin/stream`) s'authentifie auprès de Jellyfin par
 * l'en-tête `Authorization`, pour le maître, les variantes, les segments et les sous-titres, et
 * Jellyfin lit l'en-tête avant la requête — vérifié contre le serveur le 25/09/2026 : en-tête valide
 * et `ApiKey` faux, 200 ; en-tête faux et `ApiKey` valide, 401. Le paramètre ne décidait donc déjà
 * de rien ; il ne faisait que circuler.
 */

/**
 * `ApiKey`, `api_key`, `apikey`, avec leur valeur — jusqu'à ce qui termine un paramètre ou une
 * adresse, pour valoir aussi sur un manifeste entier.
 */
const AFTER_AMP = /&api_?key=[^&\s"#]*/gi;
const FIRST_THEN_MORE = /\?api_?key=[^&\s"#]*&/gi;
const FIRST_ALONE = /\?api_?key=[^&\s"#]*/gi;

/** Le texte sans ses paramètres de jeton : une chaîne de requête, une adresse, ou un manifeste. */
export function stripAccessToken(text: string): string {
  // En trois passes plutôt qu'une expression qui avale le `&` suivant : celle-là ne voyait plus un
  // second jeton collé au premier. `&ApiKey=x` disparaît ; `?ApiKey=x&a` devient `?a` ; `?ApiKey=x`
  // seul ne laisse rien.
  return text.replace(AFTER_AMP, "").replace(FIRST_THEN_MORE, "?").replace(FIRST_ALONE, "");
}

/**
 * Le laissez-passer de diffusion (`castToken.ts`) dans une adresse : sa valeur est remplacée, le nom
 * reste — on lit encore dans le journal qu'une adresse en portait un.
 */
const CAST_TOKEN = /([?&]castToken=)[^&\s"#]*/gi;

/**
 * Un texte venu du navigateur, avant qu'il n'entre dans un journal (revue de sécurité du 20/10/2026).
 *
 * Les lignes du lecteur et les erreurs du navigateur recopient des adresses — une source qui a
 * échoué, la page ouverte, une pile — et ces adresses peuvent porter le jeton Jellyfin de la
 * personne ou le laissez-passer d'un téléviseur. Les journaux se lisent, se copient dans un
 * signalement, se gardent des semaines : un jeton n'a rien à y faire, quel que soit le chemin
 * qui l'y a mis.
 */
export function redactLogText(text: string): string {
  return stripAccessToken(text).replace(CAST_TOKEN, "$1-");
}
