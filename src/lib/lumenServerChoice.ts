/**
 * Lumen serveur dans le lecteur de l'application (étape 4 de docs/remux-serveur/, DECISIONS.md §180) :
 * ce qui décide, côté page, qu'une lecture **peut** passer par lui — l'option de l'appareil, la page
 * encore vierge de toute MediaSource, et les titres que ce chemin a déjà rendus au lecteur actuel.
 *
 * Trois faits, tenus ici et nulle part ailleurs, parce que l'aiguillage (`PlayerHost` →
 * `choosePlayer`) et l'hôte (`LumenServerHost`) les lisent tous deux :
 *
 * - **L'option**, `localStorage["cine:lumen-serveur"] = "1"`, rangée par appareil comme le simulateur
 *   d'iPad (`ipadSimulator.ts`) et le choix d'interface (§106) : un administrateur l'allume sur l'iPhone
 *   qu'il veut éprouver, pas sur tous ses appareils. Absente, illisible ou stockage refusé : coupée.
 *   Lue **une fois par séance** (`lumenChoiceFor`) : basculer l'option pendant un film ne change pas de
 *   lecteur sous le spectateur (point fragile n° 9 du cycle de vie) ; l'épisode suivant (`advance`
 *   remplace l'objet séance) la relit, ce qui est voulu.
 * - **La page a-t-elle servi une MediaSource ?** WebKit refuse ensuite tout HLS natif dans la même page
 *   (code 4, aucun segment demandé — fait 3 de 3-client.md, la raison du rechargement direct de
 *   `serverReload.ts`). Le lecteur actuel le note ici au moment où il attache sa source
 *   (`noteMediaSourceServed`) ; une écriture de module, invisible des empreintes.
 * - **Les titres rendus au lecteur actuel** (`lumenDeclined`) : un refus du serveur, une panne avant la
 *   première image. Pour toute la page, par titre — sans quoi la route redeviendrait `"lumen"` au rendu
 *   suivant et la lecture bouclerait entre les deux chemins.
 *
 * Rien ici n'écrit dans le stockage hors du panneau Compte (`setLumenServer`) : l'option coupée, aucune
 * clé n'existe, aucune lecture n'est enregistrée par les empreintes, et la route reste `"native"`.
 */

import { playsHlsNatively } from "@/lib/webkitEngine";
import { readDialogueMode } from "@/lib/dialoguePreference";

export const LUMEN_SERVER_KEY = "cine:lumen-serveur";

const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}

/** Pour `useSyncExternalStore` : l'option et la liste des titres rendus changent ensemble rarement. */
export function subscribeLumenServer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** L'option est-elle allumée sur cet appareil ? Toute erreur de stockage se lit « coupée ». */
export function lumenServerOn(): boolean {
  try {
    return window.localStorage.getItem(LUMEN_SERVER_KEY) === "1";
  } catch {
    return false;
  }
}

/** Le panneau Compte, et lui seul. Vaut à la prochaine ouverture d'un film : rien à recharger. */
export function setLumenServer(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(LUMEN_SERVER_KEY, "1");
    else window.localStorage.removeItem(LUMEN_SERVER_KEY);
  } catch {
    // Stockage refusé (navigation privée) : l'option reste coupée, comme elle se lit.
  }
  notify();
}

/**
 * L'option, figée pour cet objet séance : lue à la première demande, jamais relue. `advance` remplace
 * l'objet (épisode suivant), une réouverture aussi : chacune relit l'appareil.
 */
const choices = new WeakMap<object, boolean>();
export function lumenChoiceFor(session: object): boolean {
  const held = choices.get(session);
  if (held !== undefined) return held;
  const on = lumenServerOn();
  choices.set(session, on);
  return on;
}

/**
 * L'essai « Garder le son éveillé pendant la pause » (17/11/2026), sous l'option, coupé par défaut : un son inaudible
 * joué pendant une pause garde la sortie audio éveillée, pour que le son reparte avec l'image (`audioKeepAwake.ts`).
 * Remplace l'essai du saut sur place, mesuré sans effet (0,48 s de son perdu contre 0,45 s sans). Rangé sur
 * l'appareil ; lu à chaque pause.
 */
export const LUMEN_KEEP_AWAKE_KEY = "cine:lumen-son-eveille";

export function lumenKeepAwakeOn(): boolean {
  try {
    return window.localStorage.getItem(LUMEN_KEEP_AWAKE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLumenKeepAwake(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(LUMEN_KEEP_AWAKE_KEY, "1");
    else window.localStorage.removeItem(LUMEN_KEEP_AWAKE_KEY);
    // L'essai précédent, retiré : sa clé ne doit pas rester sur l'appareil.
    window.localStorage.removeItem("cine:lumen-reprise-saut");
  } catch {
    // Stockage refusé : l'essai reste coupé, comme il se lit.
  }
  notify();
}

let mediaSourceServed = false;

/** Le lecteur actuel attache une MediaSource dans cette page : plus de HLS natif possible ici. */
export function noteMediaSourceServed(): void {
  mediaSourceServed = true;
}

export function pageServedMediaSource(): boolean {
  return mediaSourceServed;
}

const declined = new Set<string>();
let declinedVersion = 0;

/** Ce titre retourne au lecteur actuel pour le reste de la page — sans boucle (§180). */
export function declineLumen(itemId: string): void {
  if (declined.has(itemId)) return;
  declined.add(itemId);
  declinedVersion += 1;
  notify();
}

export function lumenDeclined(itemId: string): boolean {
  return declined.has(itemId);
}

/** Un nombre qui change à chaque titre rendu : ce que `PlayerHost` observe pour se redessiner. */
export function lumenDeclinedVersion(): number {
  return declinedVersion;
}

/**
 * La séance peut-elle passer par Lumen serveur — `ctx.lumen` de `choosePlayer` ? Tout ce que la page sait
 * sans rien demander : l'option, WebKit avec son HLS natif (Chrome et Firefox restent sur le lecteur
 * actuel, phase 1 sans hls.js), ni banc d'essai (il mesure le lecteur actuel) ni extrait de test, ni
 * fichier hors ligne, la page vierge de MediaSource, et le titre jamais rendu. Le serveur décide du reste
 * (`eligibility`) : un refus devient un déclin silencieux, dans l'hôte.
 */
export function lumenWanted(
  session: { itemId: string; bench?: string; labSample?: unknown; offline?: unknown },
  probe: { option: boolean; nativeHls?: () => boolean; mediaSourceServed?: () => boolean; declined?: (itemId: string) => boolean; dialogue?: () => boolean } = { option: false }
): boolean {
  if (!probe.option) return false;
  if (session.bench || session.labSample || session.offline) return false;
  // « Améliorer les dialogues » allumé sur l'appareil (§188) : le traitement vit dans la chaîne audio du lecteur actuel
  // (§68), et le son de Lumen serveur ne passe pas par la page — le lecteur actuel, qui le fait.
  if ((probe.dialogue ?? (() => readDialogueMode() !== "off"))()) return false;
  if ((probe.declined ?? lumenDeclined)(session.itemId)) return false;
  if ((probe.mediaSourceServed ?? pageServedMediaSource)()) return false;
  return (probe.nativeHls ?? (() => playsHlsNatively()))();
}

/** Pour les tests : l'état d'une page neuve. */
export function resetLumenServerChoice(): void {
  mediaSourceServed = false;
  declined.clear();
  declinedVersion = 0;
}
