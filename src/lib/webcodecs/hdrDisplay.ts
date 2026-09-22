/**
 * L'écran affiche-t-il le HDR, et que faut-il en déduire pour Chrome sous Windows ?
 *
 * Chrome sous Windows ramène tout un film HDR sous la lumière maximale que le film annonce : sur un
 * écran qui n'affiche pas le HDR, un film annoncé à 4 000 nits devient très sombre (*2012*,
 * *Apocalypse Now*), quand Firefox le montre juste — il garde les tons moyens et écrête les
 * reflets que l'écran ne sait de toute façon pas rendre. Un film annoncé à 657 nits (*Dirty
 * Dancing*) s'affiche bien dans ce même Chrome (22/09/2026). Plafonner la lumière annoncée à ce
 * niveau-là donne à Chrome le rendu de Firefox.
 *
 * Seulement quand l'écran n'affiche pas le HDR : sur un vrai écran HDR, Chrome a la place de
 * rendre toute la plage, et le plafond ne ferait qu'écrêter des reflets qu'il sait montrer.
 */

/** Le niveau jugé juste, à l'œil, sur le film qui s'affichait bien (MaxCLL 657). */
export const SDR_LIGHT_CAP_NITS = 650;

/**
 * Chrome ou Edge sous Windows : un défaut d'implémentation qu'aucune capacité ne trahit, d'où un
 * test d'agent utilisateur, comme pour WebKit. Chrome sur Mac et Android n'ont pas été observés.
 */
export function isChromiumOnWindows(userAgent: string): boolean {
  return /Windows/i.test(userAgent) && /Chrom(e|ium)|Edg\//i.test(userAgent) && !/Firefox/i.test(userAgent);
}

/**
 * La réponse du navigateur à « peux-tu afficher du HDR, là, maintenant ? » — la requête média
 * standard `dynamic-range: high`. `null` quand elle n'existe pas ou ne répond pas.
 */
export function displayIsHdr(): boolean | null {
  try {
    if (typeof matchMedia !== "function") return null;
    return matchMedia("(dynamic-range: high)").matches;
  } catch {
    return null;
  }
}

/** Le plafond à appliquer, ou `null`. Une réponse inconnue ne plafonne pas : dans le doute, rien. */
export function hdrLightCap(userAgent: string, displayHdr: boolean | null): number | null {
  return isChromiumOnWindows(userAgent) && displayHdr === false ? SDR_LIGHT_CAP_NITS : null;
}
