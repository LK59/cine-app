/**
 * Ce que le réseau de l'appareil permet au passage d'arrière-plan (DECISIONS.md §104).
 *
 * Passe de nuit du 15/10/2026 (ROBUSTESSE-12) : au premier lancement sur un appareil neuf, 70 à 77 Mo
 * partaient en une dizaine de secondes pour garder l'ouverture de cinq titres — le budget par titre
 * était respecté (`budget.ts`), mais rien ne regardait le réseau, alors que les visuels des fiches
 * (`prefetchBanners.ts`) et le préchauffage des décodeurs (`decoderWarmup.ts`) le font déjà. Pour un
 * téléphone en itinérance, c'est un forfait entamé avant d'avoir rien choisi.
 *
 * - économie de données (`connection.saveData`) : **rien** n'est téléchargé d'avance ;
 * - données mobiles (`connection.type === "cellular"`) : le titre en tête — le premier de
 *   « Reprendre », sinon d'« À suivre » — tout de suite, et chacun des suivants
 *   `CELLULAR_SPACING_MS` plus tard, la page visible et au repos ;
 * - Wi-Fi, filaire ou inconnu : inchangé.
 *
 * `navigator.connection` n'existe que dans Chromium (Android surtout ; `type` n'y est donné que sur
 * Android et ChromeOS). Safari — iPhone, iPad, Mac — et Firefox n'en disent rien : le comportement y
 * reste celui d'avant. Relu avant chaque titre : un téléphone qui passe du Wi-Fi à la 4G en cours de
 * passage ralentit au titre suivant, et l'inverse reprend le rythme normal.
 */

export type ResumeNetworkMode = "normal" | "cellulaire" | "économie";

/** L'écart entre deux titres en données mobiles : dix titres en vingt minutes au lieu de dix secondes. */
export const CELLULAR_SPACING_MS = 2 * 60_000;

interface ConnectionLike {
  saveData?: boolean;
  type?: string;
}

/** Le mode d'après ce que dit `navigator.connection` (absent : normal). Ne lève jamais. */
export function resumeNetworkMode(connection: ConnectionLike | null | undefined): ResumeNetworkMode {
  try {
    if (!connection) return "normal";
    if (connection.saveData === true) return "économie";
    if (connection.type === "cellular") return "cellulaire";
    return "normal";
  } catch {
    return "normal";
  }
}

/** Le mode de cet appareil, maintenant. */
export function currentResumeNetworkMode(): ResumeNetworkMode {
  if (typeof navigator === "undefined") return "normal";
  try {
    return resumeNetworkMode((navigator as Navigator & { connection?: ConnectionLike }).connection);
  } catch {
    return "normal";
  }
}

/**
 * Avant un titre : combien attendre, ou `null` pour ne rien télécharger. `sinceLastMs` : le temps
 * écoulé depuis le dernier titre parti au réseau dans cette page (`null` : aucun encore).
 *
 * Mesuré depuis le dernier titre et non compté par passage : un passage interrompu (page cachée, liste
 * changée) en relance un autre, qui sinon repartirait d'un « premier titre » immédiat à chaque retour
 * au premier plan.
 */
export function waitBeforeTitle(mode: ResumeNetworkMode, sinceLastMs: number | null): number | null {
  if (mode === "économie") return null;
  if (mode === "cellulaire" && sinceLastMs !== null) return Math.max(0, CELLULAR_SPACING_MS - sinceLastMs);
  return 0;
}
