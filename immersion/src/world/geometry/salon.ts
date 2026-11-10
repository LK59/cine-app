import { CylinderGeometry, LatheGeometry, Vector2 } from "three";
import { BREAST, CHANDELIER, DOOR, FIRE, HIFI, LAMPS, ROOM, SOFA, TABLE, TRUSSES, TV, roofY, span, type Solid } from "../layout";
import { Kits, roof } from "./envelope";
import type { Part } from "./types";

const W = ROOM.halfW;
const N = ROOM.north;
const S = ROOM.south;

/** Les trois fenêtres du mur ouest du salon : leur centre le long du mur. */
export const WEST_WINDOWS = [-5.62, -2.88, -0.12] as const;
export const WEST_WINDOW = { width: 1.5, sill: 0.95, top: 3.45 } as const;

/** Les poteaux de la baie nord, d'ouest en est. */
export const BAY_POSTS = [-W + 0.14, -3.3, -1.1, 1.1, 3.3, W - 0.14] as const;

/**
 * Le salon : son enveloppe (sol, murs, massif de pierre de la télévision, charpente, plafond) et ce
 * qui y est fixe et écrit en code — tapis, table basse, poufs, lampadaires, lustre.
 *
 * Tout part du plan (`layout.ts`) : chaque dimension se règle à un seul endroit. Un maillage par matière.
 */
export function buildSalon(): Part {
  const kits = new Kits();
  const floor = kits.get("floor");
  const stone = kits.get("stone");
  const slab = kits.get("slab");
  const plaster = kits.get("plaster");
  const timber = kits.get("timber");

  // ── Le sol : des lames qui filent vers la baie ──────────────────────────────
  floor.span(-W, W, -0.06, 0, N, S, 2);

  // ── La pierre : le mur est, et le massif qui porte la télévision ────────────
  stone.span(W, W + 0.3, 0, ROOM.eave + 0.2, N, S);
  const tvZ0 = TV.z - TV.width / 2 - 0.05;
  const tvZ1 = TV.z + TV.width / 2 + 0.05;
  const tvY0 = TV.y - TV.height / 2 - 0.05;
  const tvY1 = TV.y + TV.height / 2 + 0.05;
  const top = roofY(BREAST.face) + 0.06;
  stone.span(BREAST.face, W, 0, top, BREAST.z0, tvZ0);
  stone.span(BREAST.face, W, 0, top, tvZ1, BREAST.z1);
  // Sous l'écran, le massif est creusé du foyer : la pierre l'entoure, une tôle noire le tapisse.
  stone.span(BREAST.face, W, 0, FIRE.y0, tvZ0, tvZ1);
  stone.span(BREAST.face, W, FIRE.y1, tvY0, tvZ0, tvZ1);
  stone.span(BREAST.face, W, FIRE.y0, FIRE.y1, tvZ0, FIRE.z0);
  stone.span(BREAST.face, W, FIRE.y0, FIRE.y1, FIRE.z1, tvZ1);
  stone.span(BREAST.face + FIRE.depth, W, FIRE.y0, FIRE.y1, FIRE.z0, FIRE.z1);
  const fx = BREAST.face + FIRE.depth;
  const fireMetal = kits.get("metal");
  fireMetal.span(fx - 0.012, fx, FIRE.y0, FIRE.y1, FIRE.z0, FIRE.z1);
  fireMetal.span(BREAST.face, fx, FIRE.y0, FIRE.y0 + 0.012, FIRE.z0, FIRE.z1);
  fireMetal.span(BREAST.face, fx, FIRE.y1 - 0.012, FIRE.y1, FIRE.z0, FIRE.z1);
  fireMetal.span(BREAST.face, fx, FIRE.y0, FIRE.y1, FIRE.z0, FIRE.z0 + 0.012);
  fireMetal.span(BREAST.face, fx, FIRE.y0, FIRE.y1, FIRE.z1 - 0.012, FIRE.z1);
  // Le cadre de l'ouverture, à fleur de pierre.
  fireMetal.span(BREAST.face - 0.012, BREAST.face, FIRE.y0 - 0.03, FIRE.y0, FIRE.z0 - 0.03, FIRE.z1 + 0.03);
  fireMetal.span(BREAST.face - 0.012, BREAST.face, FIRE.y1, FIRE.y1 + 0.03, FIRE.z0 - 0.03, FIRE.z1 + 0.03);
  fireMetal.span(BREAST.face - 0.012, BREAST.face, FIRE.y0, FIRE.y1, FIRE.z0 - 0.03, FIRE.z0);
  fireMetal.span(BREAST.face - 0.012, BREAST.face, FIRE.y0, FIRE.y1, FIRE.z1, FIRE.z1 + 0.03);
  stone.span(BREAST.face, W, tvY1, top, tvZ0, tvZ1);
  // Le fond de la niche, derrière la dalle.
  stone.span(TV.x + 0.06, W, tvY0, tvY1, tvZ0, tvZ1);
  // Le socle du banc de l'âtre, et sa dalle.
  stone.span(BREAST.face - 0.6, BREAST.face, 0, 0.38, BREAST.z0 - 0.15, BREAST.z1 + 0.15);
  slab.span(BREAST.face - 0.66, BREAST.face, 0.38, 0.44, BREAST.z0 - 0.2, BREAST.z1 + 0.2);

  // ── L'enduit : le mur ouest autour de ses fenêtres ──────────────────────────
  const ww = WEST_WINDOW;
  plaster.wall(
    "z",
    -W - 0.3,
    0.3,
    N,
    S,
    0,
    ROOM.eave + 0.2,
    WEST_WINDOWS.map((z) => ({ a0: z - ww.width / 2, a1: z + ww.width / 2, y0: ww.sill, y1: ww.top }))
  );

  // ── Le toit, puis la charpente propre au salon ──────────────────────────────
  roof(kits, N, S, 0.4);
  const ridgeY = ROOM.ridge - 0.22;
  for (const z of TRUSSES) {
    for (const side of [-1, 1]) {
      // Arbalétrier.
      timber.beam([side * (W - 0.2), ROOM.eave - 0.02, z], [side * 0.1, ridgeY - 0.05, z], 0.26, 0.34);
      // Poteau contre le mur — pas à l'est au droit de la télévision, où le massif en tient lieu.
      if (side < 0 || z !== TRUSSES[1]) timber.span(side * W - (side > 0 ? 0.3 : 0), side * W + (side < 0 ? 0.3 : 0), 0, ROOM.eave - 0.28, z - 0.15, z + 0.15, 1);
      // L'aisselier cintré : une suite de courtes pièces le long d'une courbe, du poteau à l'entrait.
      // Pas à l'est sur la ferme du milieu : il descendrait devant l'écran.
      if (side > 0 && z === TRUSSES[1]) continue;
      const a = { x: W - 0.34, y: 3.0 };
      const c = { x: 4.45, y: 5.55 };
      const b = { x: 1.25, y: 6.86 };
      const steps = 9;
      let prev: [number, number, number] = [side * a.x, a.y, z];
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const k = 1 - t;
        const next: [number, number, number] = [side * (k * k * a.x + 2 * k * t * c.x + t * t * b.x), k * k * a.y + 2 * k * t * c.y + t * t * b.y, z];
        timber.beam(prev, next, 0.2, 0.24);
        prev = next;
      }
    }
    // Entrait retroussé et poinçon.
    timber.beam([-2.3, 7.0, z], [2.3, 7.0, z], 0.24, 0.3);
    timber.span(-0.12, 0.12, 7.1, ridgeY, z - 0.12, z + 0.12, 1);
  }
  // Le manteau : une pièce massive sous l'écran.
  timber.beam([BREAST.face - 0.19, 0.9, BREAST.z0 + 0.45], [BREAST.face - 0.19, 0.9, BREAST.z1 - 0.45], 0.4, 0.2);
  // Les encadrements des fenêtres ouest.
  for (const z of WEST_WINDOWS) {
    const x = -W + 0.02;
    timber.beam([x, ww.sill - 0.05, z - ww.width / 2 - 0.1], [x, ww.sill - 0.05, z + ww.width / 2 + 0.1], 0.14, 0.1);
    timber.beam([x, ww.top + 0.06, z - ww.width / 2 - 0.1], [x, ww.top + 0.06, z + ww.width / 2 + 0.1], 0.1, 0.12);
    for (const edge of [-1, 1]) timber.span(x - 0.05, x + 0.05, ww.sill, ww.top, z + edge * (ww.width / 2 + 0.05) - 0.05, z + edge * (ww.width / 2 + 0.05) + 0.05, 1);
    // Petits bois : une croisée.
    timber.span(x - 0.02, x + 0.02, ww.sill, ww.top, z - 0.02, z + 0.02, 1);
    for (const y of [1.78, 2.62]) timber.beam([x, y, z - ww.width / 2], [x, y, z + ww.width / 2], 0.04, 0.04);
  }
  // La baie nord : poteaux jusqu'au toit, traverses, petits bois.
  const zb = N + 0.13;
  for (const x of BAY_POSTS) timber.span(x - 0.13, x + 0.13, 0, roofY(x) - 0.1, zb - 0.13, zb + 0.13, 1);
  // La lisse basse s'interrompt devant la porte-fenêtre : un simple seuil, qu'on enjambe sans y penser.
  timber.beam([-W, 0.14, zb], [DOOR.x0 - 0.02, 0.14, zb], 0.26, 0.28);
  timber.beam([DOOR.x1 + 0.02, 0.14, zb], [W, 0.14, zb], 0.26, 0.28);
  timber.span(DOOR.x0 - 0.02, DOOR.x1 + 0.02, 0, 0.02, zb - 0.12, zb + 0.12, 0);
  timber.beam([-W, 3.2, zb], [W, 3.2, zb], 0.22, 0.2);
  timber.beam([-W, ROOM.eave - 0.02, zb], [W, ROOM.eave - 0.02, zb], 0.26, 0.26);
  for (const side of [-1, 1]) timber.beam([side * (W - 0.1), ROOM.eave + 0.02, zb], [side * 0.05, ROOM.ridge - 0.34, zb], 0.22, 0.24);
  for (let i = 0; i < BAY_POSTS.length - 1; i++) {
    const x0 = BAY_POSTS[i] + 0.13;
    const x1 = BAY_POSTS[i + 1] - 0.13;
    const mid = (x0 + x1) / 2;
    // En bas : de grands vitrages, une seule traverse.
    timber.beam([x0, 2.25, zb], [x1, 2.25, zb], 0.05, 0.05);
    // Dans la travée de la porte, ce montant descend jusqu'au sol : c'est contre lui que le vantail ferme.
    timber.span(mid - 0.025, mid + 0.025, Math.abs(mid) < 0.01 ? 0.02 : 0.28, 3.1, zb - 0.025, zb + 0.025, 1);
    // Au-dessus : les petits carreaux.
    timber.beam([x0, 3.92, zb], [x1, 3.92, zb], 0.045, 0.045);
    for (const t of [1 / 3, 2 / 3]) {
      const x = x0 + (x1 - x0) * t;
      timber.span(x - 0.022, x + 0.022, 3.3, ROOM.eave - 0.15, zb - 0.022, zb + 0.022, 1);
    }
    // Dans le pignon : montants jusqu'au toit, et des traverses là où la hauteur le permet.
    for (const t of [0.25, 0.5, 0.75]) {
      const x = x0 + (x1 - x0) * t;
      const h = roofY(x) - 0.28;
      if (h > ROOM.eave + 0.3) timber.span(x - 0.022, x + 0.022, ROOM.eave + 0.11, h, zb - 0.022, zb + 0.022, 1);
    }
    for (const y of [5.5, 6.45, 7.4]) {
      const reach = (ROOM.ridge - y - 0.3) / ((ROOM.ridge - ROOM.eave) / W);
      const a = Math.max(x0, -reach);
      const b = Math.min(x1, reach);
      if (b - a > 0.2) timber.beam([a, y, zb], [b, y, zb], 0.045, 0.045);
    }
  }

  // ── Le mobilier fixe écrit en code ──────────────────────────────────────────
  kits.get("rug").rounded([6.3, 0.028, 6.0], 0.012, { at: [-0.35, 0.014, -1.5] });
  const leather = kits.get("leather");
  leather.rounded([0.9, 0.34, 0.9], 0.09, { at: [3.2, 0.25, -2.6] });
  leather.rounded([0.9, 0.34, 0.9], 0.09, { at: [3.2, 0.25, -0.4] });
  const wood = kits.get("wood");
  wood.rounded([TABLE.w, 0.07, TABLE.d], 0.012, { at: [TABLE.x, TABLE.h - 0.035, TABLE.z] }, 0);
  wood.rounded([TABLE.w - 0.2, 0.03, TABLE.d - 0.16], 0.008, { at: [TABLE.x, 0.13, TABLE.z] }, 0);
  for (const [x, z] of [
    [3.2, -2.6],
    [3.2, -0.4],
  ]) {
    wood.box([0.8, 0.07, 0.8], { at: [x, 0.045, z] }, 0);
  }
  // Les guéridons à côté des lampadaires.
  for (const [x, z] of LAMPS) wood.add(new CylinderGeometry(0.27, 0.27, 0.045, 28), { at: [x + 0.62, 0.56, z] }, 0);

  // Le métal noir : piètement de la table, lampadaires, lustre.
  const metal = kits.get("metal");
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      metal.box([0.035, TABLE.h - 0.07, 0.035], { at: [TABLE.x + sx * (TABLE.w / 2 - 0.06), (TABLE.h - 0.07) / 2, TABLE.z + sz * (TABLE.d / 2 - 0.06)] });
    }
  for (const [x, z] of LAMPS) {
    metal.add(new CylinderGeometry(0.17, 0.19, 0.03, 24), { at: [x, 0.015, z] });
    metal.add(new CylinderGeometry(0.014, 0.014, 1.42, 10), { at: [x, 0.74, z] });
    // Le guéridon : un fût et un pied.
    metal.add(new CylinderGeometry(0.018, 0.018, 0.54, 10), { at: [x + 0.62, 0.27, z] });
    metal.add(new CylinderGeometry(0.16, 0.17, 0.02, 20), { at: [x + 0.62, 0.01, z] });
  }
  // Le lustre : deux anneaux plats, leurs tiges jusqu'au faîtage.
  const { x: cx, z: cz, y: cy, r1, r2, rise } = CHANDELIER;
  const band = (radius: number) => new LatheGeometry([new Vector2(radius - 0.035, -0.06), new Vector2(radius + 0.035, -0.06), new Vector2(radius + 0.035, 0.06), new Vector2(radius - 0.035, 0.06), new Vector2(radius - 0.035, -0.06)], 72);
  metal.add(band(r1), { at: [cx, cy, cz] });
  metal.add(band(r2), { at: [cx, cy + rise, cz] });
  const hub: [number, number, number] = [cx, ROOM.ridge - 0.5, cz];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const inner: [number, number, number] = [cx + Math.cos(a) * r2, cy + rise, cz + Math.sin(a) * r2];
    metal.beam([cx + Math.cos(a) * r1, cy, cz + Math.sin(a) * r1], inner, 0.016, 0.016);
    metal.beam(inner, hub, 0.016, 0.016);
  }
  metal.add(new CylinderGeometry(0.09, 0.05, 0.14, 16), { at: [hub[0], hub[1] + 0.05, hub[2]] });

  const { backX, frontX, wingEnd, z0, z1, depth } = SOFA;
  // ── La console de la chaîne hi-fi : basse, sous la fenêtre ouest, avec sa niche à disques ──────
  {
    const c = HIFI.console;
    const cabinetKit = kits.get("cabinet");
    cabinetKit.span(c.x0, c.x1, 0.1, c.top - 0.03, c.z0, c.z0 + 0.03, 1);
    cabinetKit.span(c.x0, c.x1, 0.1, c.top - 0.03, c.z1 - 0.03, c.z1, 1);
    cabinetKit.span(c.x0, c.x1, 0.1, 0.13, c.z0, c.z1, 2);
    cabinetKit.span(c.x0, c.x0 + 0.02, 0.1, c.top - 0.03, c.z0, c.z1, 2);
    // Deux portes pleines aux extrémités, une niche ouverte au milieu.
    for (const [a, b] of [
      [c.z0 + 0.03, c.z0 + 0.5],
      [c.z1 - 0.5, c.z1 - 0.03],
    ]) cabinetKit.span(c.x1 - 0.02, c.x1, 0.13, c.top - 0.03, a, b, 1);
    cabinetKit.span(c.x0, c.x1, 0.13, c.top - 0.03, c.z0 + 0.5, c.z0 + 0.52, 1);
    cabinetKit.span(c.x0, c.x1, 0.13, c.top - 0.03, c.z1 - 0.52, c.z1 - 0.5, 1);
    kits.get("wood").span(c.x0, c.x1 + 0.015, c.top - 0.03, c.top, c.z0 - 0.015, c.z1 + 0.015, 2);
    kits.get("metal").span(c.x0 + 0.04, c.x1 - 0.04, 0, 0.1, c.z0 + 0.06, c.z1 - 0.06);
    // Les disques, debout dans la niche : des tranches de pochettes.
    const sleeves = kits.get("leather");
    for (let i = 0; i < 16; i++) sleeves.span(c.x0 + 0.05, c.x1 - 0.06, 0.135, 0.135 + 0.31 + (i % 3) * 0.006, c.z0 + 0.56 + i * 0.034, c.z0 + 0.56 + i * 0.034 + 0.028);
  }

  const solids: Solid[] = [
    span(-40, 40, -1, 0, -40, 40),
    span(-W - 0.4, -W, 0, 9, N, S),
    span(W, W + 0.4, 0, 9, N, S),
    // La baie, moins le passage de la porte-fenêtre (le vantail a sa propre collision, `Door.tsx`).
    span(-W, DOOR.x0, 0, 9, N - 0.1, N + 0.26),
    span(DOOR.x1, W, 0, 9, N - 0.1, N + 0.26),
    span(DOOR.x0, DOOR.x1, 2.25, 9, N - 0.1, N + 0.26),
    // Le massif de pierre et le banc de l'âtre à son pied.
    span(BREAST.face, W, 0, 5, BREAST.z0, BREAST.z1),
    span(BREAST.face - 0.66, BREAST.face, 0, 0.46, BREAST.z0 - 0.2, BREAST.z1 + 0.2),
    // Les poteaux qui avancent dans la pièce, au droit des fermes (côté ouest).
    ...TRUSSES.map((z) => span(-W, -W + 0.3, 0, 4.6, z - 0.15, z + 0.15)),
    // Le canapé, la table, les poufs, les lampadaires.
    span(backX - 0.05, frontX, 0, 0.95, z0, z1),
    span(frontX, wingEnd, 0, 0.95, z0, z0 + depth),
    span(frontX, wingEnd, 0, 0.95, z1 - depth, z1),
    span(TABLE.x - TABLE.w / 2, TABLE.x + TABLE.w / 2, 0, TABLE.h + 0.05, TABLE.z - TABLE.d / 2, TABLE.z + TABLE.d / 2),
    span(2.75, 3.65, 0, 0.42, -3.05, -2.15),
    span(2.75, 3.65, 0, 0.42, -0.85, 0.05),
    ...LAMPS.map(([x, z]) => span(x - 0.2, x + 0.2, 0, 1.8, z - 0.2, z + 0.2)),
    span(HIFI.console.x0, HIFI.console.x1, 0, HIFI.console.top + 0.3, HIFI.console.z0, HIFI.console.z1),
  ];

  return { meshes: kits.build(), solids };
}

/**
 * Le canapé en boîtes adoucies : la version écrite en code, qui tient lieu de canapé tant que le
 * modèle (`public/assets/models/sofa/`) n'est pas là — et de secours s'il ne se charge pas.
 */
export function buildBlockSofa(): Part {
  const kits = new Kits();
  const sofa = kits.get("fabric");
  const { backX, frontX, wingEnd, z0, z1, depth } = SOFA;
  const seatTop = 0.47;
  sofa.rounded([frontX - backX, 0.24, z1 - z0], 0.05, { at: [(backX + frontX) / 2, 0.19, (z0 + z1) / 2] });
  sofa.rounded([wingEnd - frontX, 0.24, depth], 0.05, { at: [(frontX + wingEnd) / 2, 0.19, z0 + depth / 2] });
  sofa.rounded([wingEnd - frontX, 0.24, depth], 0.05, { at: [(frontX + wingEnd) / 2, 0.19, z1 - depth / 2] });
  sofa.rounded([0.2, 0.78, z1 - z0], 0.07, { at: [backX + 0.1, 0.46, (z0 + z1) / 2] });
  sofa.rounded([wingEnd - backX, 0.78, 0.2], 0.07, { at: [(backX + wingEnd) / 2, 0.46, z0 + 0.1] });
  sofa.rounded([wingEnd - backX, 0.78, 0.2], 0.07, { at: [(backX + wingEnd) / 2, 0.46, z1 - 0.1] });
  for (const z of [z0 + depth / 2, z1 - depth / 2]) sofa.rounded([0.22, 0.6, depth], 0.08, { at: [wingEnd + 0.03, 0.37, z] });
  const inner0 = z0 + 0.2;
  const seatW = (z1 - 0.2 - inner0) / 5;
  for (let i = 0; i < 5; i++) {
    const z = inner0 + seatW * (i + 0.5);
    sofa.rounded([frontX - backX - 0.2, 0.2, seatW - 0.02], 0.07, { at: [(backX + 0.2 + frontX) / 2 + 0.02, seatTop - 0.1, z] });
    sofa.rounded([0.24, 0.5, seatW - 0.03], 0.1, { at: [backX + 0.34, seatTop + 0.22, z], rot: [0, 0, 0.16] });
  }
  for (const [edge, dir] of [
    [z0, 1],
    [z1, -1],
  ] as const) {
    const w = (wingEnd - frontX) / 3;
    for (let i = 0; i < 3; i++) {
      const x = frontX + w * (i + 0.5);
      sofa.rounded([w - 0.02, 0.2, depth - 0.2], 0.07, { at: [x, seatTop - 0.1, edge + dir * (0.2 + (depth - 0.2) / 2 + 0.02)] });
      sofa.rounded([w - 0.03, 0.5, 0.24], 0.1, { at: [x, seatTop + 0.22, edge + dir * 0.34], rot: [dir * -0.16, 0, 0] });
    }
  }
  const pillows: { at: [number, number, number]; yaw: number; lean: number; spin: number; size: number; fabric: "pillowA" | "pillowB" }[] = [
    { at: [backX + 0.52, 0.71, z0 + 0.62], yaw: Math.PI / 2 - 0.5, lean: 0.34, spin: 0.08, size: 0.5, fabric: "pillowB" },
    { at: [backX + 0.56, 0.69, z0 + 1.2], yaw: Math.PI / 2 - 0.1, lean: 0.4, spin: -0.06, size: 0.44, fabric: "pillowA" },
    { at: [backX + 0.54, 0.7, -1.5 + 0.85], yaw: Math.PI / 2 + 0.15, lean: 0.36, spin: 0.05, size: 0.48, fabric: "pillowB" },
    { at: [backX + 0.56, 0.69, z1 - 1.15], yaw: Math.PI / 2 + 0.1, lean: 0.4, spin: 0.07, size: 0.44, fabric: "pillowA" },
    { at: [backX + 0.52, 0.71, z1 - 0.6], yaw: Math.PI / 2 + 0.5, lean: 0.34, spin: -0.08, size: 0.5, fabric: "pillowB" },
    { at: [frontX + 0.75, 0.69, z0 + 0.54], yaw: 0.15, lean: 0.38, spin: 0.06, size: 0.46, fabric: "pillowA" },
    { at: [wingEnd - 0.5, 0.69, z0 + 0.55], yaw: -0.3, lean: 0.36, spin: -0.05, size: 0.46, fabric: "pillowB" },
    { at: [frontX + 0.95, 0.69, z1 - 0.54], yaw: Math.PI - 0.15, lean: 0.38, spin: 0.05, size: 0.46, fabric: "pillowB" },
    { at: [wingEnd - 0.55, 0.69, z1 - 0.55], yaw: Math.PI + 0.3, lean: 0.36, spin: -0.07, size: 0.44, fabric: "pillowA" },
  ];
  for (const p of pillows) kits.get(p.fabric).rounded([p.size, p.size, 0.19], 0.09, { at: p.at, rot: [-p.lean, p.yaw, p.spin], order: "YXZ" });
  return { meshes: kits.build(), solids: [] };
}
