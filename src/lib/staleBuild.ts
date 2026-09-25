/**
 * Un onglet plus vieux que le serveur, et quand le recharger sans que personne s'en aperçoive.
 *
 * Trouvé le 25/09/2026 : un Mac a gardé le cinéma ouvert du matin au soir et a regardé deux
 * épisodes sur le code de 08:53, à travers une dizaine de déploiements — dont les deux correctifs
 * des sauts lents dont il se plaignait. Rien ne le lui disait. La bannière « Nouvelle version
 * disponible » ne pouvait pas apparaître : elle demandait au service worker de se mettre à jour,
 * et le worker est enregistré à l'adresse `/sw.js?v=<build de la page>` — un vieil onglet
 * revérifiait donc sa propre vieille adresse, identique octet pour octet, pour toujours. Le journal
 * du relais le montrait : `/sw.js?v=…08:53` redemandé à chaque retour au premier plan, jusqu'à
 * 21:49.
 *
 * La question est donc posée au serveur (`/api/version`), et la réponse n'est pas une bannière :
 * la page se recharge d'elle-même, au premier moment où ça ne coûte rien — aucun film ouvert,
 * même réduit, aucun banc en cours, rien en train d'être tapé ni laissé non envoyé.
 */

/** Le serveur sert-il un autre build que celui de cette page ? Un build inconnu ne conclut rien. */
export function isStaleBuild(own: string, served: unknown): boolean {
  if (typeof served !== "string" || !served || served === "dev" || own === "dev") return false;
  return served !== own;
}

export interface ReloadMoment {
  /** Un film ouvert, plein écran ou réduit — y compris une diffusion vers un téléviseur. */
  filmOpen: boolean;
  /** Un banc d'essai en cours : il enchaîne les films, et un rechargement le tuerait. */
  benchRunning: boolean;
  /** Un champ de saisie a le focus : un texte en cours d'écriture serait perdu. */
  typing: boolean;
  /**
   * Un texte saisi et pas encore envoyé reste à l'écran, même sans le curseur dedans : un
   * signalement à moitié rédigé, laissé le temps d'aller chercher une capture dans une autre
   * application, se perdait au rechargement du retour.
   */
  unsaved: boolean;
}

export function mayReloadNow(moment: ReloadMoment): boolean {
  return !moment.filmOpen && !moment.benchRunning && !moment.typing && !moment.unsaved;
}

/** Les champs dont la valeur est du texte — pas une case, un curseur ou un fichier. */
const TEXT_LESS = new Set(["checkbox", "radio", "range", "file", "hidden", "button", "submit", "reset", "color"]);

/**
 * Ce champ, que quelqu'un a touché, garde-t-il encore un texte non envoyé ?
 *
 * Sa valeur d'origine ne dit rien ici : React tient la valeur des champs contrôlés à jour dans
 * l'attribut lui-même, si bien qu'un champ modifié paraît toujours intact. On regarde donc les
 * champs où quelqu'un a tapé, et qui sont encore à l'écran avec un texte dedans. Un formulaire
 * envoyé se vide ou se ferme ; il cesse alors de compter.
 */
export function holdsUnsavedText(element: Element): boolean {
  if (!element.isConnected) return false;
  if (typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement) return element.value.trim() !== "";
  if (typeof HTMLInputElement !== "undefined" && element instanceof HTMLInputElement) {
    return !TEXT_LESS.has(element.type) && element.value.trim() !== "";
  }
  if (element instanceof HTMLElement && element.isContentEditable) return (element.textContent ?? "").trim() !== "";
  return false;
}

/**
 * Une seule fois par build servi. Si la page rechargée est encore l'ancienne — un cache
 * intermédiaire, un déploiement à moitié publié —, recharger à nouveau ferait une boucle ; on
 * attend alors le build suivant. Même garde que `chunkError.ts`, et même stockage : l'onglet.
 */
const RELOADED_FOR = "cine:build-reloaded-for";

export function alreadyReloadedFor(served: string): boolean {
  try {
    return sessionStorage.getItem(RELOADED_FOR) === served;
  } catch {
    // Pas de stockage : sans garde contre la boucle, on préfère ne pas recharger du tout.
    return true;
  }
}

export function markReloadedFor(served: string): void {
  try {
    sessionStorage.setItem(RELOADED_FOR, served);
  } catch {
    /* voir alreadyReloadedFor */
  }
}
