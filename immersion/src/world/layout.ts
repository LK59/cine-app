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
  /** Fond de la maison, au sud. */
  back: 10,
  /** Hauteur des murs gouttereaux (est et ouest). */
  eave: 4.6,
  /** Hauteur du faîtage, qui court du nord au sud à X = 0. */
  ridge: 8.6,
  /** Plancher de la mezzanine, au-dessus de la partie sud. */
  loft: 2.9,
  wall: 0.3,
} as const;

/** Pente du toit : ce que le plafond perd en hauteur par mètre vers l'est ou l'ouest. */
export const ROOF_SLOPE = (ROOM.ridge - ROOM.eave) / ROOM.halfW;
export const ROOF_ANGLE = Math.atan(ROOF_SLOPE);
/** Hauteur du dessous du toit à l'abscisse `x`. */
export const roofY = (x: number) => ROOM.ridge - Math.abs(x) * ROOF_SLOPE;

/** Les fermes de la charpente : leur position le long du salon. */
export const TRUSSES = [-4.25, -1.5, 1.25] as const;

/** Le massif de pierre qui porte la télévision : il avance dans la pièce depuis le mur est. */
export const BREAST = {
  /** Sa face, côté pièce. */
  face: ROOM.halfW - 0.4,
  z0: -4.5,
  z1: 1.5,
} as const;

/** La télévision, encastrée dans le massif de pierre. 16:9. */
export const TV = {
  width: 4.6,
  height: 4.6 * (9 / 16),
  /** La dalle, en retrait de la face du massif. */
  x: BREAST.face + 0.07,
  y: 2.42,
  z: -1.5,
} as const;

/**
 * Le canapé en U, ouvert vers la télévision : un grand côté à l'ouest (dos au mur ouest, face à
 * l'écran) et deux ailes qui avancent vers l'est.
 */
export const SOFA = {
  /** Le grand côté : de `backX` (son dos) à `frontX` (le bord de l'assise). */
  backX: -2.55,
  frontX: -1.5,
  /** Les ailes vont du grand côté jusqu'ici. */
  wingEnd: 1.25,
  z0: TV.z - 2.35,
  z1: TV.z + 2.35,
  /** Profondeur d'une aile. */
  depth: 1.02,
  /** Où se pose le regard une fois assis : au milieu du grand côté, face à l'écran. */
  seatEye: [-1.92, 1.1, TV.z] as [number, number, number],
  /** Où l'on se retrouve debout en se levant : entre le canapé et la table basse. */
  standPoint: [-1.08, 0, TV.z] as [number, number, number],
} as const;

/** La table basse, au creux du U. */
export const TABLE = { x: 0.25, z: TV.z, w: 1.55, d: 0.82, h: 0.42 } as const;

/** Les deux lampadaires, derrière les angles du canapé. */
export const LAMPS: [number, number][] = [
  [-3.25, SOFA.z0 - 0.55],
  [-3.25, SOFA.z1 + 0.55],
];

/** Le lustre, au-dessus du canapé : deux anneaux de bougies. */
export const CHANDELIER = { x: -0.1, z: TV.z, y: 4.75, r1: 1.5, r2: 0.92, rise: 0.78 } as const;

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
