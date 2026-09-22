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

import { isWebKitEngine } from "@/lib/webkitEngine";

/**
 * Le plafond de lumière HDR : « auto » par défaut, « natif », ou un nombre de nits.
 *
 * Chrome assombrit d'un diaphragme fixe tout ce qui passe sous son blanc de référence dès que la
 * lumière annoncée dépasse environ deux fois ce blanc (opérateur ST 2094-50 annexe C). Ce blanc
 * vaut 203 nits sur un écran qui n'affiche pas le HDR : annoncer 203, c'est retirer cet
 * assombrissement. Comparé à l'œil sur toute la gamme (22/09/2026, Chrome Windows, écran SDR) :
 * 203 est le plus fidèle, plus que Firefox. D'où « auto » = 203 là, et le fichier tel quel
 * ailleurs, en attendant d'avoir regardé les autres navigateurs.
 */
export type HdrCapChoice = "auto" | "native" | number;

export const HDR_CAP_CHOICES: readonly HdrCapChoice[] = ["auto", "native", 650, 400, 203, 150, 100];

/** Le blanc de référence de Chrome sur un écran SDR, mesuré dans `chrome://gpu`. */
export const CHROME_SDR_WHITE_NITS = 203;

const HDR_CAP_KEY = "cine.hdrLightCap";

/** Le choix fait sur cet appareil ; « auto » quand il n'y en a pas, ou qu'il est illisible. */
export function readHdrCapChoice(): HdrCapChoice {
  try {
    const stored = globalThis.localStorage?.getItem(HDR_CAP_KEY);
    if (stored === "native") return "native";
    const nits = Number(stored);
    return stored && HDR_CAP_CHOICES.includes(nits) ? nits : "auto";
  } catch {
    return "auto";
  }
}

export function writeHdrCapChoice(choice: HdrCapChoice): void {
  try {
    if (choice === "auto") globalThis.localStorage?.removeItem(HDR_CAP_KEY);
    else globalThis.localStorage?.setItem(HDR_CAP_KEY, String(choice));
  } catch {
    // Navigation privée ou stockage refusé : le choix vaut pour cette ouverture seulement.
  }
}

/** Ce que « auto » veut dire ici : 203 pour Chrome/Edge sous Windows sur écran SDR, sinon rien. */
export function autoHdrCap(userAgent: string, displayHdr: boolean | null): number | null {
  return isChromiumOnWindows(userAgent) && displayHdr === false ? CHROME_SDR_WHITE_NITS : null;
}

/**
 * Le réglage a-t-il un sens ici ? Sur un écran HDR, le plafond ne ferait qu'écrêter des reflets
 * que l'écran sait montrer ; sous WebKit, la conversion (EDR) est déjà juste et n'a pas à être
 * corrigée. Une réponse inconnue de l'écran ne le propose pas non plus : dans le doute, rien.
 */
export function hdrCapRelevant(userAgent: string, displayHdr: boolean | null): boolean {
  return displayHdr === false && !isWebKitEngine(userAgent);
}

export function resolveHdrCap(choice: HdrCapChoice, userAgent: string, displayHdr: boolean | null): number | null {
  if (!hdrCapRelevant(userAgent, displayHdr)) return null;
  if (choice === "native") return null;
  if (choice === "auto") return autoHdrCap(userAgent, displayHdr);
  return choice;
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

/** `color-gamut: p3`, comme `displayIsHdr` : `null` quand la question ne répond pas. */
export function displayIsWideGamut(): boolean | null {
  try {
    if (typeof matchMedia !== "function") return null;
    return matchMedia("(color-gamut: p3)").matches;
  } catch {
    return null;
  }
}

/** Le plafond à appliquer à la prochaine ouverture, ou `null` (le fichier tel quel). */
export function hdrLightCap(): number | null {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return resolveHdrCap(readHdrCapChoice(), userAgent, displayIsHdr());
}
