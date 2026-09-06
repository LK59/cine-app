/**
 * Combien d'épisodes se sont enchaînés sans que personne ne touche à rien.
 *
 * Le lecteur passe seul à l'épisode suivant à la fin du générique. C'est ce qu'on veut — jusqu'au
 * moment où c'est la télévision qui regarde toute seule : la nuit avance, le fichier suivant se
 * charge, et personne n'est là depuis longtemps.
 *
 * Au bout de trois enchaînements d'affilée, le lecteur pose la question au lieu de continuer.
 * Répondre remet le compteur à zéro et lance l'épisode ; ne pas répondre laisse simplement
 * l'écran sur sa question, ce qui est exactement ce qu'on veut d'une pièce vide.
 *
 * Vit hors de React : le composant qui compte est remonté à chaque épisode — c'est ce qui remet
 * son décompte à zéro — et un compteur qui vivrait dedans repartirait donc de zéro lui aussi, à
 * chaque fois, sans jamais atteindre trois.
 */

/** Après combien d'enchaînements automatiques la question se pose. */
export const STILL_THERE_AFTER = 3;

let consecutive = 0;
const listeners = new Set<() => void>();

/**
 * Ne prévient que si la valeur a changé.
 *
 * « Quelqu'un est là » est appelé au moindre mouvement de pointeur : prévenir à chaque fois
 * ferait redessiner les commandes du lecteur à la fréquence de la souris, pour dire trois cents
 * fois de suite la même chose.
 */
function set(next: number): void {
  if (next === consecutive) return;
  consecutive = next;
  for (const listener of listeners) listener();
}

/** Un épisode vient de s'enchaîner tout seul. */
export function noteAutoAdvance(): void {
  set(consecutive + 1);
}

/**
 * Quelqu'un est là.
 *
 * Appelé à chaque signe de présence — un geste sur les commandes, une lecture lancée à la main.
 * Un spectateur qui a bougé n'a pas à se justifier trois épisodes plus tard.
 */
export function noteViewerPresent(): void {
  set(0);
}

/** Le compteur, lu par les commandes du lecteur pendant leur rendu. */
export const autoAdvanceStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: (): number => consecutive,
  serverSnapshot: (): number => 0,
};
