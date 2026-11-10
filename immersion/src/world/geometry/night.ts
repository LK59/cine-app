import { CylinderGeometry } from "three";
import { BED, BEDROOM_WINDOW, PLAN, ROOM, SCREENS, span, type Solid } from "../layout";
import { Kits } from "./envelope";
import type { Part } from "./types";

const W = ROOM.halfW;
const B = ROOM.back;
const hall = PLAN.hall;
const bed = PLAN.bedroom;
/** Épaisseur de la cloison entre le couloir et la chambre. */
const PARTITION = 0.14;

/** Les appliques du couloir et les lampes de chevet : où elles éclairent. */
export const NIGHT_LAMPS = {
  sconces: [
    [-4.2, 1.85, hall.z1 - 0.07],
    [0.2, 1.85, hall.z1 - 0.07],
  ] as [number, number, number][],
  bedside: [
    [BED.headX + 0.28, 0.98, BED.z - BED.width / 2 - 0.42],
    [BED.headX + 0.28, 0.98, BED.z + BED.width / 2 + 0.42],
  ] as [number, number, number][],
  /**
   * Deux appliques de part et d'autre de la télévision de la chambre, sur le mur est : sans elles, ce
   * mur — à l'opposé des lampes de chevet — restait dans le noir.
   */
  screenSconces: [
    [PLAN.bedroom.x1 - 0.07, 1.78, BED.z - 1.42],
    [PLAN.bedroom.x1 - 0.07, 1.78, BED.z + 1.42],
  ] as [number, number, number][],
};

/**
 * La partie nuit, de plain-pied derrière le mur du fond : un couloir, puis la chambre et sa
 * télévision face au lit.
 */
export function buildNight(): Part {
  const kits = new Kits();
  const floor = kits.get("floor");
  const plaster = kits.get("plaster");
  const planks = kits.get("planks");
  const timber = kits.get("timber");
  const wood = kits.get("wood");
  const cabinet = kits.get("cabinet");
  const linen = kits.get("linen");
  const metal = kits.get("metal");
  const z0 = B + 0.3;
  const zEnd = bed.z1;
  const h = bed.height;
  const door = PLAN.bedroomDoor;
  const win = BEDROOM_WINDOW;

  // ── L'enveloppe : sol, murs, plafond de lames ───────────────────────────────
  floor.span(-W, hall.x1, -0.06, 0, z0, zEnd, 0);
  // Le seuil de la porte du couloir, dans l'épaisseur du mur du fond.
  floor.span(PLAN.hallDoor.x - PLAN.hallDoor.width / 2, PLAN.hallDoor.x + PLAN.hallDoor.width / 2, -0.06, 0, B, z0, 2);
  planks.span(-W, hall.x1, h, h + 0.05, z0, zEnd, 0);
  plaster.wall("z", -W - 0.3, 0.3, z0, zEnd, 0, h + 0.05);
  plaster.wall("z", hall.x1, 0.3, z0, zEnd, 0, h + 0.05);
  plaster.wall("x", zEnd, 0.3, -W, hall.x1, 0, h + 0.05, [{ a0: win.x0, a1: win.x1, y0: win.y0, y1: win.y1 }]);
  // La cloison de la chambre, et sa porte.
  plaster.wall("x", hall.z1 - PARTITION / 2, PARTITION, -W, hall.x1, 0, h, [{ a0: door.x - door.width / 2, a1: door.x + door.width / 2, y0: 0, y1: door.height }]);
  // Les montants débordent de quelques millimètres dans le passage : posés au nu du tableau de la
  // cloison, les deux faces se disputaient les mêmes pixels (un bord en dents de scie).
  for (const edge of [-1, 1]) timber.span(door.x + edge * (door.width / 2 + 0.035) - 0.043, door.x + edge * (door.width / 2 + 0.035) + 0.043, 0, door.height + 0.08, hall.z1 - 0.1, hall.z1 + 0.1, 1);
  timber.beam([door.x - door.width / 2 - 0.08, door.height + 0.04, hall.z1], [door.x + door.width / 2 + 0.08, door.height + 0.04, hall.z1], 0.2, 0.08);
  // Plinthes, et la fenêtre de la chambre : tablette, linteau, montants.
  timber.beam([win.x0 - 0.08, win.y0 - 0.04, zEnd - 0.03], [win.x1 + 0.08, win.y0 - 0.04, zEnd - 0.03], 0.2, 0.08);
  timber.beam([win.x0 - 0.08, win.y1 + 0.04, zEnd - 0.01], [win.x1 + 0.08, win.y1 + 0.04, zEnd - 0.01], 0.12, 0.08);
  for (const x of [win.x0 - 0.04, win.x0 + (win.x1 - win.x0) / 3, win.x0 + ((win.x1 - win.x0) * 2) / 3, win.x1 + 0.04]) timber.span(x - 0.035, x + 0.035, win.y0, win.y1, zEnd - 0.05, zEnd + 0.04, 1);
  // Deux solives apparentes au plafond de la chambre.
  for (const z of [bed.z0 + 1.5, bed.z0 + 3.3]) timber.beam([-W, h - 0.09, z], [hall.x1, h - 0.09, z], 0.16, 0.18);

  // ── Le couloir : une console, deux appliques ────────────────────────────────
  wood.span(-4.6, -3.4, 0.78, 0.82, z0, z0 + 0.34, 0);
  for (const x of [-4.55, -3.45]) metal.span(x - 0.015, x + 0.015, 0, 0.78, z0 + 0.03, z0 + 0.31);
  for (const [x, y, z] of NIGHT_LAMPS.sconces) metal.span(x - 0.05, x + 0.05, y - 0.16, y - 0.12, z - 0.09, z);
  for (const [x, y, z] of NIGHT_LAMPS.screenSconces) metal.span(x - 0.02, x + 0.07, y - 0.16, y - 0.12, z - 0.05, z + 0.05);
  kits.get("rug").rounded([5.6, 0.02, 0.9], 0.01, { at: [-2.1, 0.01, (z0 + hall.z1) / 2 - 0.02] });

  // ── La chambre ──────────────────────────────────────────────────────────────
  const bx0 = BED.headX;
  const bx1 = bx0 + BED.length;
  const bz0 = BED.z - BED.width / 2;
  const bz1 = BED.z + BED.width / 2;
  // Le lit : un sommier de bois bas, une tête de lit capitonnée, le matelas, la couette, les oreillers.
  wood.rounded([BED.length + 0.1, 0.22, BED.width + 0.12], 0.02, { at: [(bx0 + bx1) / 2 + 0.03, 0.2, BED.z] }, 0);
  metal.span(bx0 + 0.15, bx1 - 0.1, 0, 0.09, bz0 + 0.2, bz1 - 0.2);
  kits.get("fabric").rounded([0.14, 1.05, BED.width + 0.5], 0.05, { at: [bx0 - 0.02, 0.72, BED.z] });
  for (const zz of [-0.62, 0, 0.62]) kits.get("fabric").rounded([0.05, 0.9, 0.58], 0.04, { at: [bx0 + 0.055, 0.76, BED.z + zz] });
  linen.rounded([BED.length - 0.04, 0.24, BED.width - 0.04], 0.07, { at: [(bx0 + bx1) / 2 + 0.02, 0.43, BED.z] });
  linen.rounded([BED.length - 0.62, 0.13, BED.width + 0.14], 0.06, { at: [bx0 + 0.62 + (BED.length - 0.62) / 2 + 0.04, 0.585, BED.z] });
  // Le rabat de la couette, et un plaid au pied du lit.
  linen.rounded([0.34, 0.07, BED.width + 0.1], 0.03, { at: [bx0 + 0.78, 0.67, BED.z] });
  kits.get("pillowB").rounded([0.62, 0.05, BED.width + 0.2], 0.022, { at: [bx1 - 0.36, 0.672, BED.z], rot: [0, 0.03, 0] });
  for (const [dz, lean] of [
    [-0.47, 0.5],
    [0.47, 0.46],
  ] as const) {
    linen.rounded([0.2, 0.44, 0.72], 0.09, { at: [bx0 + 0.24, 0.8, BED.z + dz], rot: [0, 0, -lean] });
    linen.rounded([0.17, 0.4, 0.66], 0.08, { at: [bx0 + 0.46, 0.74, BED.z + dz * 0.97], rot: [0, 0, -lean - 0.25] });
  }
  kits.get("pillowA").rounded([0.15, 0.3, 0.52], 0.07, { at: [bx0 + 0.66, 0.73, BED.z], rot: [0, 0, -0.85] });
  // Le banc de cuir, au pied du lit ; le tapis.
  kits.get("leather").rounded([0.44, 0.3, 1.5], 0.07, { at: [bx1 + 0.42, 0.3, BED.z] });
  metal.span(bx1 + 0.24, bx1 + 0.6, 0, 0.15, BED.z - 0.7, BED.z + 0.7);
  kits.get("rug").rounded([3.2, 0.024, 3.3], 0.012, { at: [bx1 - 0.2, 0.012, BED.z] });
  // Les chevets (écrits en code : un caisson, un tiroir) et le pied de leurs lampes.
  for (const [lx, , lz] of NIGHT_LAMPS.bedside) {
    cabinet.rounded([0.46, 0.5, 0.5], 0.012, { at: [bx0 + 0.25, 0.3, lz] }, 0);
    cabinet.rounded([0.02, 0.16, 0.42], 0.005, { at: [bx0 + 0.49, 0.42, lz] }, 2);
    metal.span(bx0 + 0.06, bx0 + 0.44, 0, 0.05, lz - 0.2, lz + 0.2);
    metal.add(new CylinderGeometry(0.07, 0.085, 0.02, 20), { at: [lx, 0.56, lz] });
    metal.add(new CylinderGeometry(0.012, 0.012, 0.3, 8), { at: [lx, 0.71, lz] });
  }
  // L'armoire, contre la cloison ; le meuble bas sous la télévision.
  cabinet.span(-0.7, hall.x1 - 0.02, 0.08, 2.3, hall.z1 + PARTITION / 2, hall.z1 + 0.68, 1);
  metal.span(-0.66, hall.x1 - 0.06, 0, 0.08, hall.z1 + 0.12, hall.z1 + 0.62);
  for (const x of [-0.46, 0.02, 0.5, 0.96]) cabinet.rounded([0.455, 2.14, 0.022], 0.006, { at: [x, 1.19, hall.z1 + 0.69] }, 1);
  const tv = SCREENS.find((screen) => screen.id === "chambre")!;
  // Le meuble bas déborde l'écran de chaque côté, comme sous une vraie télévision.
  const half = tv.width / 2 + 0.22;
  cabinet.span(hall.x1 - 0.42, hall.x1 - 0.01, 0.1, 0.56, tv.center[2] - half, tv.center[2] + half, 2);
  wood.span(hall.x1 - 0.44, hall.x1, 0.56, 0.59, tv.center[2] - half - 0.02, tv.center[2] + half + 0.02, 2);
  metal.span(hall.x1 - 0.38, hall.x1 - 0.05, 0, 0.1, tv.center[2] - half + 0.05, tv.center[2] + half - 0.05);
  // La tringle et les rideaux de la fenêtre : deux pans de lin, tirés de chaque côté.
  metal.beam([win.x0 - 0.5, win.y1 + 0.2, zEnd - 0.12], [win.x1 + 0.5, win.y1 + 0.2, zEnd - 0.12], 0.02, 0.02);
  for (const x of [win.x0 - 0.3, win.x1 + 0.3]) {
    for (let i = 0; i < 6; i++) linen.rounded([0.11, win.y1 + 0.15, 0.09], 0.04, { at: [x - 0.25 + i * 0.1, (win.y1 + 0.2) / 2 + 0.02, zEnd - 0.12 + (i % 2) * 0.03] });
  }

  const solids: Solid[] = [
    span(-W - 0.4, -W, 0, h, z0, zEnd),
    span(hall.x1, hall.x1 + 0.4, 0, h, z0 - 0.3, zEnd),
    span(-W, hall.x1, 0, h, zEnd, zEnd + 0.4),
    // La cloison, de part et d'autre de la porte de la chambre.
    span(-W, door.x - door.width / 2, 0, h, hall.z1 - PARTITION / 2, hall.z1 + PARTITION / 2),
    span(door.x + door.width / 2, hall.x1, 0, h, hall.z1 - PARTITION / 2, hall.z1 + PARTITION / 2),
    // Le fond du couloir, côté est (le mur du fond du corps principal fait le reste).
    span(-4.65, -3.35, 0, 0.85, z0, z0 + 0.36),
    span(bx0 - 0.1, bx1 + 0.08, 0, 0.75, bz0 - 0.06, bz1 + 0.06),
    span(bx1 + 0.2, bx1 + 0.64, 0, 0.45, BED.z - 0.75, BED.z + 0.75),
    ...NIGHT_LAMPS.bedside.map(([, , lz]) => span(bx0, bx0 + 0.5, 0, 0.6, lz - 0.26, lz + 0.26)),
    span(-0.72, hall.x1, 0, 2.3, hall.z1, hall.z1 + 0.7),
    span(hall.x1 - 0.45, hall.x1, 0, 0.6, tv.center[2] - 0.88, tv.center[2] + 0.88),
  ];
  return { meshes: kits.build(), solids };
}
