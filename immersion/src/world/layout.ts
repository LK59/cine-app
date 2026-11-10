/**
 * Le plan du chalet, en mètres. Une seule source pour ce qui se voit et ce qui arrête le visiteur :
 * la géométrie et les collisions lisent les mêmes nombres.
 *
 * Repère : Y vers le haut, X vers l'est, Z vers le sud. Le salon est centré sur X = 0 ; la baie
 * vitrée est au nord (Z négatif), le mur de pierre et la télévision à l'est (X positif).
 */
export const ROOM = {
  /** Demi-largeur du salon (murs est et ouest à ±halfW). */
  halfW: 5.5,
  /** Mur nord (la baie vitrée). */
  north: -7,
  /** Limite sud du volume double hauteur (au-delà : cuisine sous la mezzanine). */
  south: 4,
  /** Hauteur des murs gouttereaux (est et ouest). */
  eave: 4.6,
  /** Hauteur du faîtage, qui court du nord au sud à X = 0. */
  ridge: 8.6,
  wall: 0.3,
} as const;

/** La télévision, encastrée dans le mur de pierre (est). 16:9. */
export const TV = {
  width: 4.6,
  height: 4.6 * (9 / 16),
  /** Centre de la dalle. */
  x: ROOM.halfW - 0.12,
  y: 2.42,
  z: -1.5,
} as const;

/** Le canapé en U, ouvert vers la télévision. */
export const SOFA = {
  /** Centre du U (au sol). */
  x: -0.4,
  z: TV.z,
  /** Où se pose le regard une fois assis : au milieu du dossier, face à l'écran. */
  seatEye: [-1.55, 1.12, TV.z] as [number, number, number],
  /** Où l'on se retrouve debout en se levant : entre le canapé et la table basse. */
  standPoint: [-0.55, 0, TV.z + 0.9] as [number, number, number],
} as const;

export const PLAYER = {
  radius: 0.28,
  /** Hauteur totale de la capsule. */
  height: 1.75,
  /** Hauteur des yeux au-dessus du sol. */
  eye: 1.64,
  walk: 2.4,
  run: 4.6,
  /** Arrivée dans le salon, depuis le sud, le regard vers la baie et la télévision. */
  spawn: [-1.2, 0, 3.1] as [number, number, number],
  spawnYaw: -0.32,
  spawnPitch: 0.04,
} as const;

/** Une boîte de collision : centre, demi-dimensions, rotation éventuelle autour de Y. */
export interface Solid {
  p: [number, number, number];
  h: [number, number, number];
  ry?: number;
}

/** Boîte donnée par ses bornes — plus lisible pour les murs. */
export function span(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Solid {
  return { p: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2] };
}
