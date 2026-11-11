import { BEDROOM_WINDOW, PLAN, ROOM } from "../layout";
import { Kits } from "./envelope";
import type { Part } from "./types";

const W = ROOM.halfW;
const B = ROOM.back;
const hall = PLAN.hall;
const bed = PLAN.bedroom;

/** L'aile de la chambre vue du dehors : ses murs extérieurs, de `x0` à `x1` et jusqu'à `z1`. */
export const WING = {
  x0: -W - 0.3,
  x1: hall.x1 + 0.3,
  z0: B + 0.3,
  z1: bed.z1 + 0.3,
  /** Hauteur de l'égout du toit, pente, débord. */
  eave: 2.72,
  slope: 0.42,
  overhang: 0.45,
} as const;

/** La porte d'entrée, au bout du couloir, dans le mur est de l'aile : son axe en Z, sa largeur, sa hauteur. */
export const FRONT_DOOR = { z: (hall.z0 + 0.3 + hall.z1) / 2, width: 0.94, height: 2.08 } as const;

/** La lanterne du dehors, à côté de la porte d'entrée. */
export const PORCH_LAMP: [number, number, number] = [WING.x1 + 0.2, 2.02, FRONT_DOOR.z + 0.78];

/** Hauteur du dessous du toit de l'aile à l'abscisse `x` (un toit à deux pans, le faîtage du nord au sud). */
export function wingRoofY(x: number): number {
  const centre = (WING.x0 + WING.x1) / 2;
  return WING.eave + ((WING.x1 - WING.x0) / 2 - Math.abs(x - centre)) * WING.slope;
}

/**
 * Le dehors de l'aile de la chambre. De la fenêtre de la cuisine, on la voyait comme un bloc sans toit ni
 * matière : elle a maintenant son toit à deux pans chargé de neige, son bardage de planches sur un
 * soubassement de pierre, sa porte d'entrée (le couloir est l'entrée du chalet) avec une marche et une
 * lanterne. Un groupe à part, cuit à part : ce qui est dedans garde toute la finesse de sa lumière.
 */
export function buildOutside(): Part {
  const kits = new Kits();
  const planks = kits.get("planks");
  const timber = kits.get("timber");
  const stone = kits.get("stone");
  const snow = kits.get("snow");
  const metal = kits.get("metal");
  const wood = kits.get("wood");
  const { x0, x1, z0, z1, eave, slope, overhang } = WING;
  const centre = (x0 + x1) / 2;
  const half = (x1 - x0) / 2;
  const plinth = 0.5;
  const win = BEDROOM_WINDOW;
  const door = FRONT_DOOR;

  // ── Les murs : un soubassement de pierre, puis un bardage de planches debout ─────────────────
  // Est (celui que voit la cuisine) : percé de la porte d'entrée.
  stone.wall("z", x1, 0.07, z0 - 0.3, z1, 0, plinth, [{ a0: door.z - door.width / 2 - 0.1, a1: door.z + door.width / 2 + 0.1, y0: 0, y1: plinth }]);
  planks.wall("z", x1, 0.04, z0 - 0.3, z1, plinth, eave + 0.04, [{ a0: door.z - door.width / 2 - 0.1, a1: door.z + door.width / 2 + 0.1, y0: plinth, y1: door.height + 0.1 }]);
  // Sud (le pignon) : percé de la fenêtre de la chambre.
  stone.wall("x", z1, 0.07, x0, x1 + 0.04, 0, plinth);
  // Son haut suit la pente et entre dans l'épaisseur du toit (la ligne médiane des planches, `wingRoofY` +
  // 0,06) ; il montait en escalier juste sous elles, un jour en triangle à chaque marche. Deux appels, coupés
  // au faîtage, pour que la pointe tombe sur un bord de bande et ne soit pas rognée.
  const gableOpening = [{ a0: win.x0 - 0.1, a1: win.x1 + 0.1, y0: win.y0 - 0.1, y1: win.y1 + 0.1 }];
  planks.wall("x", z1, 0.04, x0, centre, plinth, (x) => wingRoofY(x) + 0.06, gableOpening, 0.12);
  planks.wall("x", z1, 0.04, centre, x1 + 0.04, plinth, (x) => wingRoofY(x) + 0.06, gableOpening, 0.12);
  // Ouest.
  stone.wall("z", x0 - 0.07, 0.07, z0, z1, 0, plinth);
  planks.wall("z", x0 - 0.04, 0.04, z0, z1, plinth, eave + 0.04);
  // L'encadrement de la fenêtre, dehors.
  for (const x of [win.x0 - 0.1, win.x1 + 0.1]) timber.span(x - 0.05, x + 0.05, win.y0 - 0.14, win.y1 + 0.14, z1, z1 + 0.07, 1);
  for (const y of [win.y0 - 0.1, win.y1 + 0.1]) timber.beam([win.x0 - 0.16, y, z1 + 0.035], [win.x1 + 0.16, y, z1 + 0.035], 0.07, 0.09);

  // ── Le toit : deux pans de planches, leurs rives, et la neige ────────────────────────────────
  const angle = Math.atan(slope);
  const reach = half + overhang;
  const length = z1 + overhang - (z0 - 0.3);
  const zMid = (z0 - 0.3 + z1 + overhang) / 2;
  const slopeLength = reach / Math.cos(angle);
  for (const side of [-1, 1]) {
    const cx = centre + (side * reach) / 2;
    const cy = wingRoofY(cx) + 0.06;
    planks.box([slopeLength, 0.07, length], { at: [cx, cy, zMid], rot: [0, 0, -side * angle] }, 2);
    // La neige : épaisse, en retrait des rives, plus mince vers l'égout où elle a glissé.
    snow.rounded([slopeLength - 0.16, 0.2, length - 0.14], 0.09, { at: [cx - side * 0.03, cy + 0.14 / Math.cos(angle), zMid - 0.03], rot: [0, 0, -side * angle] });
    snow.rounded([slopeLength * 0.5, 0.12, length - 0.5], 0.06, { at: [centre + side * reach * 0.3, wingRoofY(centre + side * reach * 0.3) + 0.3, zMid - 0.1], rot: [0, 0, -side * angle] });
    // La planche de rive, à l'égout, et les chevrons qui dépassent sous le débord.
    const ex = centre + side * reach;
    timber.beam([ex, wingRoofY(ex) + 0.02, z0 - 0.3], [ex, wingRoofY(ex) + 0.02, z1 + overhang], 0.05, 0.16);
    for (let z = z0 + 0.2; z < z1 + overhang - 0.1; z += 0.72) timber.beam([centre + side * (half - 0.05), wingRoofY(centre + side * (half - 0.05)) - 0.04, z], [ex - side * 0.03, wingRoofY(ex) - 0.04, z], 0.07, 0.11);
    // La rive du pignon, qui suit la pente.
    timber.beam([centre, wingRoofY(centre) + 0.03, z1 + overhang - 0.03], [ex, wingRoofY(ex) + 0.03, z1 + overhang - 0.03], 0.05, 0.17);
  }
  // La panne faîtière et les pannes sablières, qui sortent sous le débord du pignon.
  timber.beam([centre, wingRoofY(centre) - 0.12, z1 - 0.1], [centre, wingRoofY(centre) - 0.12, z1 + overhang - 0.06], 0.14, 0.2);
  for (const side of [-1, 1]) timber.beam([centre + side * (half - 0.08), eave - 0.08, z1 - 0.1], [centre + side * (half - 0.08), eave - 0.08, z1 + overhang - 0.06], 0.14, 0.18);
  snow.rounded([0.5, 0.16, length - 0.2], 0.08, { at: [centre, wingRoofY(centre) + 0.2, zMid - 0.03] });

  // ── La porte d'entrée, côté dehors : son cadre, son vantail de planches, sa poignée, sa marche ──
  const dz0 = door.z - door.width / 2;
  const dz1 = door.z + door.width / 2;
  for (const z of [dz0 - 0.06, dz1 + 0.06]) timber.span(x1 - 0.02, x1 + 0.09, 0, door.height + 0.12, z - 0.06, z + 0.06, 1);
  timber.beam([x1 + 0.035, door.height + 0.07, dz0 - 0.14], [x1 + 0.035, door.height + 0.07, dz1 + 0.14], 0.11, 0.12);
  wood.span(x1 + 0.005, x1 + 0.05, 0.02, door.height, dz0, dz1, 1);
  for (const y of [0.32, 1.05, 1.78]) wood.beam([x1 + 0.058, y, dz0 + 0.03], [x1 + 0.058, y, dz1 - 0.03], 0.02, 0.11);
  metal.span(x1 + 0.05, x1 + 0.1, 1.0, 1.04, dz0 + 0.07, dz0 + 0.2);
  stone.span(x1 + 0.02, x1 + 0.75, 0, 0.14, dz0 - 0.25, dz1 + 0.25);
  snow.rounded([0.5, 0.07, door.width + 0.3], 0.03, { at: [x1 + 1.05, 0.03, door.z] });
  // La lanterne : une potence, une cage de métal (son verre et sa lueur sont dans `Fixtures`).
  const [lx, ly, lz] = PORCH_LAMP;
  metal.beam([x1 + 0.04, ly + 0.2, lz], [lx, ly + 0.2, lz], 0.02, 0.02);
  metal.span(lx - 0.07, lx + 0.07, ly + 0.13, ly + 0.17, lz - 0.07, lz + 0.07);
  metal.span(lx - 0.06, lx + 0.06, ly - 0.15, ly - 0.13, lz - 0.06, lz + 0.06);
  for (const [dx, dz] of [
    [-0.055, -0.055],
    [0.055, -0.055],
    [-0.055, 0.055],
    [0.055, 0.055],
  ]) metal.span(lx + dx - 0.006, lx + dx + 0.006, ly - 0.13, ly + 0.13, lz + dz - 0.006, lz + dz + 0.006);

  // Personne ne marche là : les murs de l'aile arrêtent déjà le visiteur, de l'intérieur.
  return { meshes: kits.build(), solids: [] };
}
