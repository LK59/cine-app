/**
 * L'adresse d'une image passée par l'optimiseur de Next (`/_next/image`), écrite à la main.
 *
 * Sans dépendance : lu par le serveur (les routes qui rendent un logo, le préchauffage) comme par
 * l'écran (la bannière du téléphone). Les deux doivent produire la même adresse à l'octet près —
 * c'est elle qui est la clé du cache de l'optimiseur, du cache du navigateur, et du décodage
 * anticipé de la bannière.
 */

/**
 * Les hôtes que l'optimiseur accepte — les mêmes que `images.remotePatterns` dans next.config.js.
 * Une adresse ailleurs serait refusée par Next ; la demander ne coûterait qu'un 400, mais n'aurait
 * aucun sens.
 */
const OPTIMIZABLE = [/^https:\/\/image\.tmdb\.org\/t\/p\//, /^https:\/\/artworks\.thetvdb\.com\/banners\//];

export function isOptimizable(url: string | null | undefined): url is string {
  return typeof url === "string" && OPTIMIZABLE.some((re) => re.test(url));
}

/** La qualité par défaut de next/image, la seule que l'optimiseur accepte ici (`images.qualities`). */
export const QUALITY = 75;

/** L'adresse que next/image demande pour cette image et cette largeur — à l'octet près. */
export function variantPath(url: string, width: number, quality = QUALITY): string {
  return `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=${quality}`;
}

/**
 * Les largeurs demandées pour la bannière et les logos (27/10/2026). Toutes deux dans les tailles que
 * Next accepte (`deviceSizes`). L'optimiseur n'agrandit jamais : un logo ou une affiche TMDB de
 * 500 px sort à 500 px, un fond de 1 280 px à 1 280 — seul le format change.
 */
export const BANNER_WIDTH = 640;
export const BACKDROP_WIDTH = 1920;

/**
 * Le logo, l'affiche ou le fond de la bannière, en WebP par l'optimiseur (27/10/2026).
 *
 * TMDB sert les logos en PNG : 80 à 280 Ko pour les titres de la bannière, mesurés le 27/10/2026 —
 * sur un lien lent, la bannière restait sans logo de longues secondes, le logo n'apparaissant
 * qu'entier (`CinemaLogo` attend ses proportions). Le même logo en WebP, transparence comprise, en
 * pèse quatre à six fois moins. Converti une fois, gardé un an dans `data/image-cache`
 * (`minimumCacheTTL`), préparé d'avance (`posterPrewarm`).
 *
 * **Seulement la bannière et les logos** : les affiches des rangées restent servies par TMDB en
 * direct — les faire convertir à la demande pendant le défilement a été la première cause des
 * saccades sur téléphone (02/09/2026, `CinemaCard`). Un SVG n'est pas converti (l'optimiseur le
 * refuse), une adresse d'un autre hôte — une image Jellyfin — passe telle quelle.
 */
export function bannerImage(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  if (!isOptimizable(url) || /\.svg$/i.test(url)) return url;
  return variantPath(url, width);
}
