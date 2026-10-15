/**
 * Une fiche ouverte sur un titre qui vient de quitter le catalogue (15/10/2026, DECISIONS.md §94).
 *
 * Le catalogue se relit au retour au premier plan : le titre d'une fiche ouverte peut en sortir
 * pendant qu'elle est à l'écran. La fiche ne se ferme pas d'elle-même (`useRetainedTitle` garde le
 * titre qu'elle montrait) ; mais son bouton Lecture mènerait à un fichier qui n'existe plus — un
 * écran noir, puis un repli vers le lecteur serveur qui échouerait pareil. `PlaybackProvider.play`
 * consulte donc ce drapeau, comme celui de la panne (§92), et l'appui est dit au lieu d'être joué.
 */

let retiredOnScreen = false;
let onBlocked: (() => void) | null = null;

/** Posé par l'accueil : la fiche du dessus montre-t-elle un titre retiré ? */
export function noteRetiredSheet(retired: boolean): void {
  retiredOnScreen = retired;
}

/** Ce que l'accueil fait d'un appui refusé : le message. */
export function onPlayBlockedByRetired(listener: (() => void) | null): void {
  onBlocked = listener;
}

/**
 * L'ouverture du lecteur est-elle refusée ? Vrai tant qu'une fiche de titre retiré est l'écran du
 * dessus — et l'appui est alors signalé. Gardé : un message qui échoue n'empêche pas de refuser.
 */
export function playBlockedByRetired(): boolean {
  if (!retiredOnScreen) return false;
  try {
    onBlocked?.();
  } catch {
    // Le refus tient, même sans message.
  }
  return true;
}
