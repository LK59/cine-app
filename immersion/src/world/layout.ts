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
// Les deux fermes extérieures encadrent le massif de pierre : plus serrées, leurs aisseliers mordaient sur les coins
// hauts du grand écran, vus du canapé.
export const TRUSSES = [-4.55, -1.5, 1.55] as const;

/** Le massif de pierre qui porte la télévision : il avance dans la pièce depuis le mur est. */
export const BREAST = {
  /** Sa face, côté pièce. */
  face: ROOM.halfW - 0.4,
  z0: -4.5,
  z1: 1.5,
} as const;

/** La télévision du salon, encastrée dans le massif de pierre. 16:9. */
export const TV = {
  // 5,2 m de large : presque tout le massif (6 m), du dessus des bougies du manteau jusque sous la sablière.
  width: 5.2,
  height: 5.2 * (9 / 16),
  /** La dalle, en retrait de la face du massif. */
  x: BREAST.face + 0.07,
  y: 2.78,
  z: -1.5,
} as const;

/**
 * Le foyer : une longue ouverture basse dans le massif, sous le manteau et au-dessus du banc de pierre,
 * centrée sous l'écran — le feu en ruban des chalets d'aujourd'hui.
 */
export const FIRE = {
  z0: TV.z - 1.75,
  z1: TV.z + 1.75,
  y0: 0.47,
  y1: 0.78,
  /** Profondeur de la niche dans le massif. */
  depth: 0.3,
  /** D'où part sa lueur : juste devant l'ouverture, à mi-hauteur des flammes. */
  glow: [BREAST.face - 0.22, 0.68, TV.z] as [number, number, number],
} as const;

/**
 * La porte-fenêtre : le vantail ouest de la travée centrale de la baie. Il coulisse vers l'est, derrière
 * le vantail fixe, et ouvre sur la terrasse.
 */
export const DOOR = { x0: -0.97, x1: -0.025, height: 2.22, slide: 0.93 } as const;

/** La terrasse, devant la baie : un platelage de plain-pied, bordé d'un garde-corps, face à la vallée. */
export const TERRACE = { x0: -ROOM.halfW - 0.3, x1: ROOM.halfW + 0.3, z0: ROOM.north - 4.9, z1: ROOM.north - 0.02, rail: 1.05 } as const;

/** Le bain nordique : une cuve de bois ronde, à l'angle nord-est de la terrasse. */
export const TUB = { x: 3.35, z: ROOM.north - 2.75, radius: 1.08, height: 0.88, water: 0.74 } as const;

/**
 * Le plan d'ensemble. Au sud du salon, un corps de bâtiment à deux niveaux : au rez-de-chaussée la
 * cuisine (ouverte sur le salon) et l'escalier ; au-dessus, la mezzanine. Plus au sud, un couloir et
 * une chambre de plain-pied.
 */
export const PLAN = {
  /** Cloison entre l'escalier (à l'ouest) et la cuisine (à l'est). */
  stairEast: -4.3,
  /**
   * L'escalier : une volée droite le long du mur ouest, qui monte vers le sud. Il s'arrête à plus d'un mètre
   * du mur du fond : arrivé en haut, on a un vrai palier devant soi (il n'y en avait que 54 cm).
   */
  stair: { x0: -ROOM.halfW, x1: -4.3, zBottom: 4.7, zTop: 8.95, steps: 17 },
  /** Le couloir, derrière le mur du fond. */
  hall: { x0: -ROOM.halfW, x1: 1.2, z0: ROOM.back, z1: ROOM.back + 1.7, height: 2.6 },
  /** La chambre, au bout du couloir. */
  bedroom: { x0: -ROOM.halfW, x1: 1.2, z0: ROOM.back + 1.7, z1: ROOM.back + 6.6, height: 2.6 },
  /** Les portes : passage du rez-de-chaussée vers le couloir, puis du couloir vers la chambre. */
  hallDoor: { x: -2.6, width: 1.0, height: 2.1 },
  bedroomDoor: { x: -1.2, width: 0.95, height: 2.1 },
} as const;

/** La cuisine : ses meubles fixes, le long du mur du fond, et son îlot. */
export const KITCHEN = {
  /** Meubles bas, le long du mur du fond : de `x0` à `x1`, profondeur, hauteur du plan. */
  run: { x0: -0.95, x1: 4.9, depth: 0.62, top: 0.92 },
  /** L'armoire haute (réfrigérateur intégré), à gauche des meubles bas. */
  tall: { x0: -1.75, x1: -0.95, height: 2.15 },
  island: { x0: 0.1, x1: 2.7, z0: 6.25, z1: 7.25, top: 0.92 },
  /** La fenêtre au-dessus de l'évier. */
  window: { x0: 2.5, x1: 4.5, y0: 1.16, y1: 2.12 },
  /** Le buffet sous la télévision, contre le mur est. */
  sideboard: { z0: 6.35, z1: 8.25, depth: 0.46, top: 0.82 },
} as const;

/** La chambre : le lit, tête contre le mur ouest, face à sa télévision. */
export const BED = { headX: -ROOM.halfW + 0.16, length: 2.12, z: ROOM.back + 1.7 + 2.6, width: 1.9, top: 0.56 } as const;

/** Les ouvertures vitrées hors du salon : la fenêtre de la cuisine, celle de la chambre. */
export const BEDROOM_WINDOW = { x0: -3.9, x1: -0.9, y0: 0.55, y1: 2.2 } as const;

export type RoomId = "salon" | "cuisine" | "mezzanine" | "couloir" | "chambre" | "terrasse";

/** Dans quelle pièce se trouve ce point (les pieds du visiteur) ? */
export function roomAt(x: number, y: number, z: number): RoomId {
  if (z < ROOM.north) return "terrasse";
  if (z > PLAN.bedroom.z0) return "chambre";
  if (z > ROOM.back) return "couloir";
  if (z > ROOM.south) return y > ROOM.loft - 0.4 ? "mezzanine" : "cuisine";
  return y > ROOM.loft - 0.4 ? "mezzanine" : "salon";
}

/**
 * Un écran : toutes les télévisions du chalet montrent la même image (un seul flux, une seule
 * texture) ; chacune a sa place, sa taille, son haut-parleur et sa lumière.
 */
export interface Screen {
  id: string;
  room: RoomId;
  /** Centre de la dalle. */
  center: [number, number, number];
  /** Rotation de la dalle autour de la verticale : sa face regarde +Z tournée de cet angle. */
  yaw: number;
  width: number;
  /** Jusqu'où le visiteur peut l'ouvrir (touche d'action), en mètres. */
  reach: number;
  /** Distance de référence de son haut-parleur : en deçà, plein volume. */
  loudness: number;
  /**
   * Portée de son haut-parleur, en mètres : au-delà, on ne l'entend plus du tout (le son s'éteint en
   * douceur sur le dernier quart). Les portées se recouvrent exprès : dans la cuisine on entend son
   * écran et, plus loin, celui du salon ; dans le couloir, celui de la cuisine et celui de la chambre.
   */
  range: number;
}

export const SCREENS: Screen[] = [
  { id: "salon", room: "salon", center: [TV.x, TV.y, TV.z], yaw: -Math.PI / 2, width: TV.width, reach: 6.4, loudness: 5.5, range: 14 },
  // Dans la cuisine, sur le mur est, au-dessus du buffet.
  { id: "cuisine", room: "cuisine", center: [ROOM.halfW - 0.04, 1.72, 7.3], yaw: -Math.PI / 2, width: 1.5, reach: 4.2, loudness: 2.2, range: 8 },
  // Dans la chambre, au mur face au lit, au-dessus de son meuble bas.
  { id: "chambre", room: "chambre", center: [PLAN.bedroom.x1 - 0.04, 1.5, PLAN.bedroom.z0 + 2.6], yaw: -Math.PI / 2, width: 1.9, reach: 4.4, loudness: 2.8, range: 7 },
];

/** Ce qui reste du son d'un écran à cette distance de lui : 1 jusqu'aux trois quarts de sa portée, 0 au bout. */
export function rangeGain(screen: Screen, distance: number): number {
  return fadeByRange(screen.range, distance);
}

/**
 * La chaîne hi-fi. Une console basse sous la fenêtre ouest du salon porte la platine et deux enceintes ;
 * une seconde platine est sur le meuble de la chambre. Les deux commandent **la même** musique
 * d'ambiance, diffusée par une enceinte dans chaque pièce — comme un film sur les écrans : une seule
 * source, un haut-parleur par enceinte, chacun avec sa portée.
 */
export const HIFI = {
  /** La console du salon : contre le mur ouest, sous la troisième fenêtre. */
  console: { x0: -ROOM.halfW + 0.02, x1: -ROOM.halfW + 0.5, z0: -0.95, z1: 0.71, top: 0.62 },
  /** Les platines : leur centre, posé sur un meuble. */
  decks: [
    { id: "salon", at: [-ROOM.halfW + 0.27, 0.62, -0.12] as [number, number, number], yaw: Math.PI / 2 },
    { id: "chambre", at: [PLAN.bedroom.x1 - 0.24, 0.59, PLAN.bedroom.z0 + 2.6 - 0.72] as [number, number, number], yaw: -Math.PI / 2 },
  ],
} as const;

export interface Loudspeaker {
  id: string;
  room: RoomId;
  /** Le centre de l'enceinte. */
  center: [number, number, number];
  /** Vers où elle joue : rotation autour de la verticale (sa face regarde +Z tournée de cet angle). */
  yaw: number;
  loudness: number;
  range: number;
}

export const LOUDSPEAKERS: Loudspeaker[] = [
  // Au salon : les deux enceintes de la console (un seul haut-parleur, entre elles).
  { id: "salon", room: "salon", center: [-ROOM.halfW + 0.3, 0.8, -0.12], yaw: Math.PI / 2, loudness: 3.2, range: 12 },
  // Dans la cuisine : sur l'étagère, près de la fenêtre.
  { id: "cuisine", room: "cuisine", center: [0.35, 1.69, ROOM.back - 0.14], yaw: Math.PI, loudness: 1.8, range: 6.5 },
  // Sur la mezzanine : au sol, près de la plante.
  { id: "mezzanine", room: "mezzanine", center: [4.25, ROOM.loft + 0.17, 9.45], yaw: -Math.PI * 0.75, loudness: 1.8, range: 6.5 },
  // Dans la chambre : sur le meuble, de l'autre côté de l'écran.
  { id: "chambre", room: "chambre", center: [PLAN.bedroom.x1 - 0.2, 0.59 + 0.16, PLAN.bedroom.z0 + 2.6 + 0.98], yaw: -Math.PI / 2, loudness: 2, range: 6.5 },
];

/** Ce qui reste du son d'une source à cette distance d'elle : 1 jusqu'aux trois quarts de sa portée, 0 au bout. */
export function fadeByRange(range: number, distance: number): number {
  const t = Math.min(1, Math.max(0, (distance - range * 0.75) / (range * 0.25)));
  return 1 - t * t * (3 - 2 * t);
}

export const screenHeight = (screen: Screen) => (screen.width * 9) / 16;

/** L'écran le plus proche de ce point, et sa distance. */
export function nearestScreen(x: number, y: number, z: number): { screen: Screen; distance: number } {
  let best = SCREENS[0];
  let bestDistance = Infinity;
  for (const screen of SCREENS) {
    const d = Math.hypot(screen.center[0] - x, screen.center[1] - y, screen.center[2] - z);
    if (d < bestDistance) {
      best = screen;
      bestDistance = d;
    }
  }
  return { screen: best, distance: bestDistance };
}

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

/**
 * La lune, deux fois : là où on la **voit** dans le ciel (assez basse pour entrer dans le cadre de la
 * baie depuis le canapé), et d'où vient sa **lumière** (plus haute : ses rayons tombent sur le parquet
 * au pied de la baie, avec l'ombre des petits bois, au lieu de zébrer le canapé). L'écart ne se lit pas.
 */
export const MOON = {
  seen: [-0.3, 0.52, -0.8] as [number, number, number],
  lightFrom: [-5, 22, -11] as [number, number, number],
  color: "#8fb2ff",
  intensity: 1.15,
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
