/**
 * Le lecteur occupe-t-il l'écran — et donc le clavier ?
 *
 * Une fiche reste montée sous le lecteur, pour que le refermer ramène là d'où l'on est parti. Son
 * écouteur de touches, lui, doit se taire tant que le film est en plein écran : les deux
 * reçoivent la même touche, et `stopPropagation` n'y peut rien entre deux écouteurs posés sur la
 * même fenêtre. Les fiches du bureau le savaient ; la fiche du téléphone, non — Échap sur une
 * tablette à clavier refermait le lecteur *et* la fiche dessous, deux crans d'historique d'un coup.
 *
 * Écrit une fois, pour que la prochaine fiche n'ait pas à le redécouvrir : chaque fiche le
 * demandait à sa façon (`playback.mode === "full"`), et c'est précisément ainsi qu'une des quatre
 * l'avait oublié. Voir DECISIONS.md.
 */
export function playerHoldsKeyboard(playback: { mode: string }): boolean {
  return playback.mode === "full";
}
