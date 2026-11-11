/**
 * Combien d'épisodes se sont enchaînés sans que personne ne touche à rien — la règle d'`autoAdvance` dans
 * l'application : au bout de trois, le chalet demande au lieu de continuer. Une télévision qui enchaîne toute la
 * nuit dans une pièce vide fait tourner un transcodage pour personne.
 *
 * Remis à zéro par toute commande de lecture venue du visiteur (`commands.ts`) : un spectateur qui a touché à
 * quelque chose n'a pas à se justifier trois épisodes plus tard.
 */
export const STILL_THERE_AFTER = 3;

let consecutive = 0;

export function noteAutoAdvance(): void {
  consecutive += 1;
}

export function noteViewerPresent(): void {
  consecutive = 0;
}

export function autoAdvances(): number {
  return consecutive;
}
