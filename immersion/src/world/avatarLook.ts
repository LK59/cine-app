import type { Look } from "../../../salons/src/tv";

/**
 * Ce que veulent dire les quatre chiffres d'une apparence (`salons/src/tv.ts`, `Look`) : `[couleur, chapeau, écharpe,
 * lunettes]`. Les bornes y sont écrites (`LOOK_LIMITS`) ; les listes ci-dessous doivent avoir ces longueurs.
 */
export const LOOK_COLORS = ["#c8553d", "#e09f3e", "#d4b483", "#7aa95c", "#3d8b7d", "#4f7cac", "#5c5f9e", "#8f5c9e", "#b4547a", "#5b5b5f"] as const;
/** 0 : aucun ; 1 : bonnet ; 2 : casquette ; 3 : chapeau. */
export const LOOK_HATS = 4;
export const LOOK_SCARVES = LOOK_COLORS;

/** Une apparence tirée de l'identifiant, pour qui n'en a pas choisi (la même chez tous). */
export function defaultLook(id: string): Look {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [h % LOOK_COLORS.length, 0, -1, 0];
}
