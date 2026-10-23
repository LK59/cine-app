/**
 * Les bords des commandes du lecteur, partagés par `PlayerControls` et ses pièces.
 */

// Le bord bas des commandes : 8 px au-dessus de la barre d'accueil d'iOS (ou 1,5 rem sans elle).
// Collée au bord sûr, la barre de progression se trouvait sous le pouce qui allait chercher le
// geste du système, et l'un prenait l'autre (02/10/2026). Partagé par tout ce qui se place au-dessus
// de la rangée du bas, pour que l'écart reste le même partout.
export const BOTTOM_EDGE = "max(1.5rem, calc(env(safe-area-inset-bottom) + 0.5rem))";
/**
 * Où se posent les invites flottantes (« Passer l'intro », l'épisode suivant, la minuterie) : au-dessus
 * du bas des commandes — titre, pilule et barre —, pour ne jamais les couvrir quand elles sont là.
 */
export const PROMPT_BOTTOM = `calc(${BOTTOM_EDGE} + 8.5rem)`;
