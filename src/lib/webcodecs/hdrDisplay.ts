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

/**
 * Les plafonds proposés, `null` étant « natif » : la lumière du fichier, telle quelle.
 *
 * Le plafond automatique à 650 nits (22/09/2026) n'a rien changé, et l'analyse de Chrome dit
 * pourquoi : son opérateur (ST 2094-50 annexe C) assombrit d'un diaphragme fixe tout ce qui passe
 * sous le blanc de référence dès que la lumière annoncée dépasse environ deux fois ce blanc — 203
 * nits sur l'écran où c'était mesuré, donc tout MaxCLL au-dessus de ~400. En attendant de savoir à
 * l'œil ce que donne chaque niveau, c'est un choix du spectateur, par appareil, et non plus une
 * détection. 203 est le blanc de référence lui-même.
 */
export const HDR_CAP_CHOICES: readonly (number | null)[] = [null, 650, 400, 203, 150, 100];

const HDR_CAP_KEY = "cine.hdrLightCap";

/** Le plafond choisi sur cet appareil, `null` pour natif — y compris quand rien n'est lisible. */
export function readHdrCapChoice(): number | null {
  try {
    const stored = Number(globalThis.localStorage?.getItem(HDR_CAP_KEY));
    return HDR_CAP_CHOICES.includes(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function writeHdrCapChoice(nits: number | null): void {
  try {
    if (nits === null) globalThis.localStorage?.removeItem(HDR_CAP_KEY);
    else globalThis.localStorage?.setItem(HDR_CAP_KEY, String(nits));
  } catch {
    // Navigation privée ou stockage refusé : le choix vaut pour cette ouverture seulement.
  }
}

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

/** Le plafond à appliquer à la prochaine ouverture, ou `null` (natif). */
export function hdrLightCap(): number | null {
  return readHdrCapChoice();
}
