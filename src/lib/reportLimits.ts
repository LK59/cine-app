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
 * Par compte non admin : signalements créés sur 24 heures glissantes (brouillons compris), et
 * brouillons ouverts à la fois. Rien ne bornait ni l'un ni l'autre : chaque création peut porter
 * six images de 25 Mo, et `data/` porte aussi la base et les journaux — un compte pouvait remplir
 * le disque à lui seul (26/09/2026). Très au-dessus de l'usage : un signalement par jour ici.
 */
export const MAX_REPORTS_PER_DAY = 30;
export const MAX_OPEN_DRAFTS = 20;

/**
 * Par requête, tout compris. Au-delà, le proxy de Next ne garde que le début du corps et le
 * formulaire devient illisible : sa limite, `experimental.proxyClientMaxBodySize` dans
 * next.config.js, doit rester au-dessus — un test le vérifie. Il garde ce corps en mémoire, et le
 * conteneur a 2 Go : la limite n'est pas le produit des deux autres, et le téléphone réduit ce
 * qu'il peut avant (voir `prepareImage.ts`).
 */
export const MAX_REQUEST_BYTES = 90 * 1024 * 1024;
