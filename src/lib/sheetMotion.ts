/**
 * La durée de sortie d'une fiche sur téléphone, en millisecondes.
 *
 * Elle doit valoir celle de l'animation `sheet-out` de globals.css : c'est le délai pendant lequel
 * la fiche reste montée après qu'on a demandé sa fermeture. Trop court, elle disparaît au milieu
 * de son propre glissement ; trop long, l'écran reste bloqué sur une fiche déjà partie.
 *
 * Partagée entre les fiches de bibliothèque et les fiches TMDB, qui doivent s'ouvrir et se fermer
 * de la même façon — la moitié des titres d'une rangée de saga ouvre l'une, l'autre moitié
 * l'autre, et rien dans le geste ne dit laquelle.
 */
export const SHEET_OUT_MS = 280;

/**
 * Le temps de plus qu'une fiche reste montée après sa sortie, invisible, avant d'être démontée.
 *
 * Le démontage était programmé à la durée exacte de l'animation : le moindre retard du fil
 * principal le faisait tomber sur ses dernières images, et une fiche personne — une filmographie
 * de plusieurs centaines de cartes à défaire — accrochait « quand l'animation se termine »
 * (23/09/2026), au moment même où la barre du bas finissait de revenir. La fiche est déjà hors de
 * l'écran et n'accepte plus aucun appui : la garder un instant de plus ne coûte rien.
 */
export const SHEET_UNMOUNT_SLACK_MS = 120;

/**
 * La classe d'animation d'une fiche qu'on peut tirer vers le bas — entrée, sortie, ou rien.
 *
 * Trois fiches l'écrivaient chacune, dans les mêmes termes :
 * `swipe.touched ? "" : closing ? "sheet-out" : revealed ? "" : "sheet-in"`. Le premier terme
 * était juste pour l'entrée — elle anime la même transformation que le doigt, et la laisser
 * revenir après un geste revenu en place la rejouait en entier — et faux pour la sortie :
 * `touched` ne retombe jamais, donc après un simple appui sur la bannière, *chaque* fermeture
 * suivante (croix, Échap, retour) faisait disparaître la fiche d'un coup, au bout de 280 ms
 * d'immobilité. Seule une sortie menée par le geste lui-même doit se passer de `sheet-out` : la
 * carte y descend déjà par sa transition. D'où `dismissed`, et une seule fonction pour les trois.
 *
 * `out` et `into` sont les classes propres à chaque fiche : la fiche personne se pose au centre
 * sur grand écran (`md:animate-fade-*`), et la fiche de bibliothèque sort sans animation quand
 * rien n'est dessiné derrière elle.
 */
export function sheetMotionClass({
  swipe,
  leaving,
  revealed,
  out = "sheet-out",
  into = "sheet-in",
}: {
  swipe: { touched: boolean; dismissed: boolean };
  /** La fiche est en train de sortir — `leaving` de la coquille, ou `closing` de `useDelayedClose`. */
  leaving: boolean;
  revealed: boolean;
  out?: string;
  into?: string;
}): string {
  if (leaving) return swipe.dismissed ? "" : out;
  return swipe.touched || revealed ? "" : into;
}

/**
 * La classe d'animation de la colonne de contenu d'une fiche du bureau — entrée, sortie, ou rien.
 *
 * La racine de ces fiches respectait déjà `arrivedByBack` (`revealed ? "" : "animate-fade-in"`),
 * mais leur colonne jouait `animate-fade-in-up` sans condition : au retour arrière, la fiche se
 * découvrait sans bouger et son texte remontait quand même de seize pixels, contre la règle du
 * cycle de vie des fiches (CLAUDE.md). Trois fiches l'écrivaient, et la troisième — la fiche
 * TMDB — n'avait même pas de sortie (relevé le 23/09/2026). Une fonction, pour les trois.
 */
export function detailColumnMotion({ leaving, revealed }: { leaving: boolean; revealed: boolean }): string {
  if (leaving) return "animate-fade-out-down";
  return revealed ? "" : "animate-fade-in-up";
}
