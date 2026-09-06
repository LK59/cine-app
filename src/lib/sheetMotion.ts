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
