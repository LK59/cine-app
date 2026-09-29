// Les limites des captures jointes à un signalement, lues des deux côtés : le téléphone les
// applique avant d'envoyer — un refus ne doit pas coûter l'envoi de 50 Mo sur un réseau mobile —,
// et le serveur les fait respecter.

/** Par image. Une photo d'iPhone récent fait 3 à 8 Mo ; une capture d'écran bien moins. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** Par envoi (signalement ou commentaire). */
export const MAX_IMAGES = 6;
/** Par signalement, commentaires compris : `data/` porte aussi la base et les journaux. */
export const MAX_IMAGES_PER_REPORT = 24;
/**
 * Par compte non admin, sur 24 heures glissantes : images des signalements et des commentaires,
 * un seul compteur (`imageQuota`). Le plafond par signalement ne bornait pas le jour : un fil
 * après l'autre, environ 18 Go par compte (D12, 29/09/2026). Soixante, c'est dix envois complets
 * — ici, une ou deux captures par signalement.
 */
export const MAX_IMAGES_PER_DAY = 60;
/**
 * Par compte non admin : signalements créés sur 24 heures glissantes (brouillons compris), et
 * brouillons ouverts à la fois. Rien ne bornait ni l'un ni l'autre : chaque création peut porter
 * six images de 25 Mo, et `data/` porte aussi la base et les journaux — un compte pouvait remplir
 * le disque à lui seul (26/09/2026). Très au-dessus de l'usage : un signalement par jour ici.
 */
export const MAX_REPORTS_PER_DAY = 30;
export const MAX_OPEN_DRAFTS = 20;

/**
 * Par requête, tout compris : ce que le téléphone s'interdit d'envoyer (voir `prepareImage.ts`).
 * Il ne réduit pas tout — une image illisible pour lui part telle quelle —, d'où la marge de
 * `REPORT_BODY_LIMIT`.
 */
export const MAX_REQUEST_BYTES = 90 * 1024 * 1024;

/**
 * Ce que le serveur accepte d'un corps annoncé, refusé en 413 avant toute lecture.
 *
 * Les signalements sont hors du proxy (A2, 29/09/2026) : Next ne borne plus leur corps — il le
 * bornait à 100 Mo, `proxyClientMaxBodySize`, pour *toute* l'API, ce qui laissait n'importe qui
 * remplir la mémoire du conteneur sans session. La même borne, ici, et pour elles seules. Elle ne
 * lit que `Content-Length`, que tout navigateur envoie avec un `FormData` ; elle ne passe qu'après
 * la session, qui reste la vraie garde.
 */
export const REPORT_BODY_LIMIT = 100 * 1024 * 1024;
