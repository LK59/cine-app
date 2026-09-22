/**
 * Qu'un saut est « arrivé » : la tête à moins de cela de sa cible.
 *
 * Écrit une fois. Il y en avait quatre copies au 22/09/2026 — la source, deux dans l'hôte, le banc
 * —, toutes à ±1,5 s ce jour-là, et rien ne les empêchait de diverger : une ligne `seek` aurait
 * alors dit « arrivé » d'un saut que la source jugeait parti ailleurs.
 *
 * Plus large que tout pas volontaire autour d'une cible — l'atterrissage sur le premier média, une
 * poussée d'horloge figée —, qui passent par `noteSeekTarget` et déplacent la cible avec eux.
 */
export const SEEK_ARRIVAL_SECONDS = 1.5;

export function seekArrived(currentSeconds: number, targetSeconds: number): boolean {
  return Math.abs(currentSeconds - targetSeconds) <= SEEK_ARRIVAL_SECONDS;
}

/**
 * Au-delà, un fichier sans index ne peut plus être rejoint : sans point d'index, la lecture ne
 * sait repartir que du début du fichier. En deçà, repartir du début *est* la bonne réponse.
 */
export const NO_INDEX_REACH_SECONDS = 1;

/**
 * Peut-on rejoindre cette position — pour un saut, une ouverture en cours de film, un changement
 * de piste qui reconstruit ? Écrit trois fois jusqu'au 22/09/2026 (la source, à l'ouverture et au
 * saut, et la lecture au changement de piste), avec le même seuil par chance.
 */
export function reachable(seekable: boolean, seconds: number): boolean {
  return seekable || seconds <= NO_INDEX_REACH_SECONDS;
}
