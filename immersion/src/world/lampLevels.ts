/**
 * Le niveau courant des lampes de chaque groupe de pièces (0 à 1), tel que `Lights` le fait glisser à
 * chaque image. Hors de l'état React exprès : il change en continu, et plusieurs composants le lisent
 * dans leur boucle de rendu (les abat-jour, les flammes du lustre).
 */
export const lampLevels = { salon: 1, sud: 1, nuit: 1 };
