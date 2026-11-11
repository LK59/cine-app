import { BoxGeometry, ConeGeometry, CylinderGeometry, SphereGeometry } from "three";
import { KITCHEN, PLAN, ROOM, SCREENS, span, type Solid } from "../layout";
import { GABLE_TOP, Kits, roof } from "./envelope";
import type { Part } from "./types";

const W = ROOM.halfW;
const S = ROOM.south;
const B = ROOM.back;
const LOFT = ROOM.loft;
/**
 * La poutre de rive de la mezzanine : son dessus au dessous du parquet (2,5 cm sous LOFT), sa hauteur,
 * sa demi-largeur (elle est centrée sur `ROOM.south`). Son dessous descend 1,5 cm sous celui des solives
 * (LOFT − 0,37), qui s'y emboîtent : à 5 mm près, les deux faces se seraient disputé les pixels.
 */
const RIM = { top: LOFT - 0.025, height: 0.36, half: 0.15 } as const;

/**
 * Les appliques de l'escalier : une à mi-volée sur le mur ouest, une au-dessus du palier sur le mur du fond.
 * Sans elles la cage n'avait aucune lampe à elle — noire pendant un film, sombre le reste du temps. Elles ne
 * sont que des lumières et un abat-jour (`Fixtures`) : rien n'est ajouté à la géométrie cuite.
 */
export const STAIR_SCONCES: { at: [number, number, number]; out: [number, number, number] }[] = [
  { at: [-W + 0.07, 2.75, 6.3], out: [1, 0, 0] },
  { at: [-4.9, LOFT + 1.72, B - 0.07], out: [0, 0, -1] },
];

/** Où sont suspendues les lampes de l'îlot (le bas de l'abat-jour). */
export const PENDANTS: [number, number, number][] = [0.55, 1.4, 2.25].map((x) => [x, 1.92, (KITCHEN.island.z0 + KITCHEN.island.z1) / 2]);

/**
 * La partie sud du corps principal : au rez-de-chaussée la cuisine, ouverte sur le salon, et l'escalier
 * le long du mur ouest ; au-dessus, la mezzanine sous le toit.
 */
export function buildSouth(): Part {
  const kits = new Kits();
  const floor = kits.get("floor");
  const timber = kits.get("timber");
  const planks = kits.get("planks");
  const plaster = kits.get("plaster");
  const stone = kits.get("stone");
  const cabinet = kits.get("cabinet");
  const counter = kits.get("counter");
  const metal = kits.get("metal");
  const wood = kits.get("wood");
  const st = PLAN.stair;
  const rise = LOFT / st.steps;
  const run = (st.zTop - st.zBottom) / st.steps;

  // ── L'enveloppe : sol, murs, toit ───────────────────────────────────────────
  floor.span(-W, W, -0.06, 0, S, B, 2);
  // Les murs latéraux vont jusqu'au nu extérieur du pignon : ils s'arrêtaient à sa face intérieure, et
  // l'angle de la maison restait un poteau de vide sous le toit.
  stone.span(W, W + 0.3, 0, ROOM.eave + 0.2, S, B + 0.3);
  plaster.wall("z", -W - 0.3, 0.3, S, B + 0.3, 0, ROOM.eave + 0.2);
  // Les lames du toit passent par-dessus le pignon et le débordent de 10 cm.
  roof(kits, S, B, 0, 0.4);
  // Le mur du fond (un pignon) : la porte du couloir, la fenêtre de la cuisine. Son haut suit la pente et
  // entre dans l'épaisseur des lames (`GABLE_TOP`). Il montait en escalier par bandes de 50 cm, chacune à la
  // hauteur de son bout le plus bas, et les lames s'arrêtaient contre sa face : entre chaque marche et elles,
  // un jour en triangle — de la mezzanine, des points bleus (le ciel) tout le long du pignon.
  const door = PLAN.hallDoor;
  const win = KITCHEN.window;
  plaster.wall("x", B, 0.3, -W, W, 0, GABLE_TOP, [
    { a0: door.x - door.width / 2, a1: door.x + door.width / 2, y0: 0, y1: door.height },
    { a0: win.x0, a1: win.x1, y0: win.y0, y1: win.y1 },
  ]);
  // Les encadrements : la porte, la fenêtre.
  for (const edge of [-1, 1]) timber.span(door.x + edge * (door.width / 2 + 0.045) - 0.053, door.x + edge * (door.width / 2 + 0.045) + 0.053, 0, door.height + 0.1, B - 0.04, B + 0.34, 1);
  timber.beam([door.x - door.width / 2 - 0.1, door.height + 0.05, B + 0.15], [door.x + door.width / 2 + 0.1, door.height + 0.05, B + 0.15], 0.38, 0.1);
  timber.beam([win.x0 - 0.08, win.y0 - 0.04, B + 0.02], [win.x1 + 0.08, win.y0 - 0.04, B + 0.02], 0.2, 0.08);
  timber.beam([win.x0 - 0.08, win.y1 + 0.04, B + 0.02], [win.x1 + 0.08, win.y1 + 0.04, B + 0.02], 0.12, 0.08);
  for (const x of [win.x0 - 0.04, (win.x0 + win.x1) / 2, win.x1 + 0.04]) timber.span(x - 0.035, x + 0.035, win.y0, win.y1, B - 0.02, B + 0.06, 1);

  // ── La mezzanine : son plancher (percé au-dessus de l'escalier), sa rive, ses garde-corps ──
  const slabs: [number, number, number, number][] = [
    [PLAN.stairEast, W, S, B],
    [-W, PLAN.stairEast, S, st.zBottom],
    [-W, PLAN.stairEast, st.zTop, B],
  ];
  for (const [x0, x1, z0, z1] of slabs) {
    // Côté salon, le parquet avance jusqu'au nu de la poutre de rive (un nez de plancher) : c'est lui qui la
    // couvre, et plus le dessus de la poutre affleurant le parquet.
    floor.span(x0, x1, LOFT - 0.025, LOFT, z0 === S ? S - RIM.half : z0, z1, 2);
    planks.span(x0, x1, LOFT - 0.2, LOFT - 0.025, z0, z1, 0);
  }
  // La poutre de rive, sous le bord de la mezzanine. Son dessus était à LOFT, la hauteur même du parquet, sur
  // les 15 cm où elle passe sous lui : deux faces dans un même plan, qui se disputaient les pixels — un
  // clignotement au pied de la rambarde. Elle est descendue sous le parquet ; les poteaux la suivent.
  timber.beam([-W, RIM.top - RIM.height / 2, S], [W, RIM.top - RIM.height / 2, S], RIM.half * 2, RIM.height);
  for (const x of [-W + 0.15, -2.2, 2.2, W - 0.15]) timber.span(x - 0.15, x + 0.15, 0, RIM.top - RIM.height, S - RIM.half, S + RIM.half, 1);
  for (let x = -W + 0.5; x < W; x += 0.9) if (x > PLAN.stairEast + 0.1) timber.beam([x, LOFT - 0.28, S], [x, LOFT - 0.28, B], 0.12, 0.18);
  // Garde-corps : le long du vide sur le salon, et autour de la trémie de l'escalier.
  // `meets` : ce garde-corps finit contre la main courante d'un autre. Sa main courante s'arrête alors au flanc
  // de l'autre et son dernier barreau n'est pas posé (l'autre en a un au même endroit) : les deux mains
  // courantes se recouvraient sur un carré de 4,5 cm, dessus contre dessus, et deux barreaux identiques
  // occupaient la même place — de quoi clignoter à l'angle de la trémie.
  const rail = (from: [number, number], to: [number, number], meets = false) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const trim = meets ? 0.045 / length : 0;
    const end: [number, number] = [to[0] - (to[0] - from[0]) * trim, to[1] - (to[1] - from[1]) * trim];
    timber.beam([from[0], LOFT + 1.02, from[1]], [end[0], LOFT + 1.02, end[1]], 0.09, 0.07);
    const count = Math.max(2, Math.round(length / 0.135));
    for (let i = 0; i <= (meets ? count - 1 : count); i++) {
      const x = from[0] + ((to[0] - from[0]) * i) / count;
      const z = from[1] + ((to[1] - from[1]) * i) / count;
      timber.span(x - 0.016, x + 0.016, LOFT, LOFT + 1.0, z - 0.016, z + 0.016, 1);
    }
  };
  rail([-W + 0.1, S], [W - 0.1, S]);
  // Le long de la trémie sur toute sa longueur, jusqu'au palier : c'est lui qui garde le vide de l'escalier.
  rail([PLAN.stairEast, st.zBottom], [PLAN.stairEast, st.zTop]);
  rail([-W + 0.1, st.zBottom], [PLAN.stairEast, st.zBottom], true);

  // ── L'escalier : une volée droite, marches de bois, limon, rampe ────────────
  const solids: Solid[] = [];
  for (let i = 0; i < st.steps; i++) {
    const y = (i + 1) * rise;
    const z = st.zBottom + i * run;
    timber.span(st.x0 + 0.04, st.x1 - 0.02, y - 0.05, y, z - 0.02, z + run + 0.01, 0);
    planks.span(st.x0 + 0.06, st.x1 - 0.06, y - rise, y - 0.05, z + run - 0.03, z + run, 0);
    solids.push(span(st.x0, st.x1, 0, y, z, z + run + 0.02));
  }
  // Le limon, côté pièce, et la rampe qui le suit.
  const stairTop: [number, number, number] = [st.x1 - 0.03, LOFT - 0.12, st.zTop];
  timber.beam([st.x1 - 0.03, -0.12 + rise, st.zBottom], stairTop, 0.06, 0.3);
  // La rampe s'arrête sous le plancher de la mezzanine, à un poteau : plus haut, c'est le garde-corps de la
  // trémie qui borde l'escalier. Elle montait jusqu'en haut, dans le même plan que lui — deux barrières
  // mêlées, la rampe en travers à hauteur de poitrine. Sous le plancher, les barreaux montent jusqu'à lui.
  const under = LOFT - 0.2;
  const railFrom: [number, number, number] = [st.x1 - 0.03, rise + 0.95, st.zBottom + 0.1];
  const railRise = (LOFT + 0.95 - railFrom[1]) / (st.zTop - railFrom[2]);
  const railEndZ = railFrom[2] + (under - 0.06 - railFrom[1]) / railRise;
  timber.beam(railFrom, [st.x1 - 0.03, under - 0.06, railEndZ], 0.07, 0.06);
  timber.span(st.x1 - 0.07, st.x1 + 0.01, ((railEndZ - st.zBottom) / run) * rise - 0.05, under, railEndZ - 0.04, railEndZ + 0.04, 1);
  for (let i = 0; i <= st.steps; i += 1) {
    const z = st.zBottom + 0.1 + i * run * 0.985;
    const y = Math.min((i + 1) * rise, LOFT);
    const top = z < railEndZ ? railFrom[1] + (z - railFrom[2]) * railRise - 0.02 : under;
    if (top - y < 0.25) continue;
    timber.span(st.x1 - 0.046, st.x1 - 0.014, y - 0.05, top, z - 0.016, z + 0.016, 1);
  }
  // Le dessous de l'escalier, fermé côté cuisine par un panneau qui suit la pente et entre de 3 cm sous le
  // limon. Il s'arrêtait 2 à 19 cm plus bas, en escalier : une fente ouverte sous tout le limon.
  const stringerSlope = (stairTop[1] - (rise - 0.12)) / (st.zTop - st.zBottom);
  const stringerBottom = (z: number) => rise - 0.12 + (z - st.zBottom) * stringerSlope - 0.15 * Math.hypot(1, stringerSlope);
  planks.wall("z", st.x1 - 0.02, 0.04, st.zBottom + run, st.zTop, 0, (z) => Math.max(0.02, stringerBottom(z) + 0.03), [], 0.28);
  solids.push(span(st.x1 - 0.06, st.x1 + 0.04, 0, LOFT + 1.05, st.zBottom + 0.9, st.zTop));
  solids.push(span(st.x1 - 0.06, st.x1 + 0.04, 0, 1.2, st.zBottom, st.zBottom + 0.9));

  // ── La cuisine ──────────────────────────────────────────────────────────────
  const k = KITCHEN;
  const zc = B - k.run.depth;
  // Meubles bas : le corps, les façades en léger relief, le plan de pierre.
  cabinet.span(k.run.x0, k.run.x1, 0.1, k.run.top - 0.04, zc + 0.02, B, 0);
  metal.span(k.run.x0 + 0.03, k.run.x1 - 0.03, 0, 0.1, zc + 0.08, B);
  for (let x = k.run.x0; x < k.run.x1 - 0.2; x += 0.65) cabinet.rounded([0.63, 0.74, 0.022], 0.006, { at: [Math.min(x + 0.325, k.run.x1 - 0.325), 0.5, zc + 0.012] }, 1);
  counter.span(k.run.x0 - 0.01, k.run.x1 + 0.01, k.run.top - 0.04, k.run.top, zc - 0.03, B);
  // La crédence de pierre, sous les étagères.
  counter.span(k.run.x0, win.x0 - 0.1, k.run.top, 1.5, B - 0.02, B);
  // L'armoire haute.
  cabinet.span(k.tall.x0, k.tall.x1, 0.1, k.tall.height, zc + 0.02, B, 1);
  metal.span(k.tall.x0 + 0.03, k.tall.x1 - 0.03, 0, 0.1, zc + 0.08, B);
  for (const x of [k.tall.x0 + 0.2, k.tall.x1 - 0.2]) cabinet.rounded([0.39, 1.98, 0.022], 0.006, { at: [x, 1.13, zc + 0.012] }, 1);
  // La plaque de cuisson, sa hotte ; l'évier sous la fenêtre.
  metal.span(0.2, 1.0, k.run.top, k.run.top + 0.008, zc + 0.08, B - 0.1);
  metal.span(0.1, 1.1, 1.72, 2.25, B - 0.5, B);
  metal.span(0.42, 0.78, 2.25, LOFT - 0.2, B - 0.36, B - 0.06);
  metal.span(3.05, 3.95, k.run.top - 0.015, k.run.top + 0.004, zc + 0.1, B - 0.14);
  metal.add(new CylinderGeometry(0.016, 0.016, 0.3, 10), { at: [3.5, k.run.top + 0.15, B - 0.1] });
  metal.beam([3.5, k.run.top + 0.3, B - 0.1], [3.5, k.run.top + 0.3, B - 0.3], 0.03, 0.03);
  // Deux étagères entre la hotte et la fenêtre.
  for (const y of [1.52, 1.9]) wood.span(1.25, 2.38, y, y + 0.04, B - 0.26, B, 0);
  // L'îlot : un corps, des façades, un plan qui déborde côté tabourets.
  const is = k.island;
  cabinet.span(is.x0, is.x1, 0.1, is.top - 0.05, is.z0 + 0.28, is.z1, 0);
  metal.span(is.x0 + 0.04, is.x1 - 0.04, 0, 0.1, is.z0 + 0.34, is.z1 - 0.06);
  for (let x = is.x0; x < is.x1 - 0.2; x += 0.65) cabinet.rounded([0.63, 0.72, 0.022], 0.006, { at: [x + 0.325, 0.49, is.z1 + 0.012] }, 1);
  counter.rounded([is.x1 - is.x0 + 0.08, 0.05, is.z1 - is.z0 + 0.06], 0.008, { at: [(is.x0 + is.x1) / 2, is.top - 0.025, (is.z0 + is.z1) / 2] });
  // Les suspensions au-dessus de l'îlot : un fil, un cône noir.
  for (const [x, y, z] of PENDANTS) {
    metal.add(new CylinderGeometry(0.004, 0.004, LOFT - 0.2 - (y + 0.2), 6), { at: [x, (LOFT - 0.2 + y + 0.2) / 2, z] });
    metal.add(new ConeGeometry(0.17, 0.22, 28, 1, true), { at: [x, y + 0.11, z] });
  }
  // Le buffet sous la télévision de la cuisine.
  const sb = k.sideboard;
  cabinet.span(W - sb.depth, W - 0.01, 0.12, sb.top - 0.03, sb.z0, sb.z1, 2);
  wood.span(W - sb.depth - 0.02, W, sb.top - 0.03, sb.top, sb.z0 - 0.02, sb.z1 + 0.02, 2);
  for (const z of [sb.z0 + 0.12, sb.z1 - 0.12]) metal.span(W - sb.depth + 0.05, W - 0.08, 0, 0.12, z - 0.02, z + 0.02);
  for (let z = sb.z0; z < sb.z1 - 0.2; z += 0.633) cabinet.rounded([0.022, 0.6, 0.6], 0.006, { at: [W - sb.depth - 0.012, 0.46, z + 0.317] }, 1);

  // ── La mezzanine : un coin lecture — bibliothèque contre le pignon, tapis ───
  const shelfZ = B - 0.34;
  for (const x of [-2.4, -1.2, 0, 1.2, 2.4]) wood.span(x - 0.02, x + 0.02, LOFT, LOFT + 2.1, shelfZ, B, 1);
  for (const y of [0.02, 0.45, 0.88, 1.31, 1.74, 2.08]) wood.span(-2.4, 2.4, LOFT + y, LOFT + y + 0.03, shelfZ, B, 0);
  // Les livres : des blocs de dos, par travée et par rayon, de hauteurs et de teintes mêlées.
  let seed = 3;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const spines = ["white", "leather", "pillowB", "cabinet"] as const;
  for (const bay of [-2.4, -1.2, 0, 1.2])
    for (const y of [0.05, 0.48, 0.91, 1.34, 1.77]) {
      let x = bay + 0.05;
      const end = bay + 1.15 - random() * 0.5;
      while (x < end) {
        const w = 0.025 + random() * 0.035;
        const h = 0.2 + random() * 0.13;
        kits.get(spines[Math.floor(random() * spines.length)]).box([w, h, 0.17 + random() * 0.05], { at: [x + w / 2, LOFT + y + h / 2, B - 0.14], rot: [0, 0, random() < 0.12 ? 0.12 : 0] });
        x += w + 0.003;
      }
    }
  kits.get("rug").rounded([4.2, 0.025, 3.0], 0.012, { at: [0.4, LOFT + 0.013, 7.1] });

  // Le cache noir du câble des télévisions accrochées n'est pas dessiné : elles ont leur coque (`Screens`).
  const tv = SCREENS.find((screen) => screen.id === "cuisine")!;
  metal.add(new BoxGeometry(0.03, 0.2, 0.4), { at: [W - 0.02, tv.center[1], tv.center[2]] });
  // Un bol de fruits sur l'îlot (des sphères) — une touche de vie.
  for (const [dx, dz, r] of [
    [0, 0, 0.045],
    [0.07, 0.03, 0.04],
    [-0.05, 0.06, 0.042],
    [0.02, -0.06, 0.04],
  ]) {
    kits.get("pillowB").add(new SphereGeometry(r, 14, 10), { at: [2.2 + dx, is.top + r + 0.03, 6.8 + dz] });
  }
  wood.add(new CylinderGeometry(0.16, 0.1, 0.05, 24), { at: [2.2, is.top + 0.025, 6.8] });

  solids.push(
    span(-W - 0.4, -W, 0, 9, S, B),
    span(W, W + 0.4, 0, 9, S, B),
    // Le mur du fond, de part et d'autre de la porte du couloir — au rez-de-chaussée et à l'étage.
    span(-W, door.x - door.width / 2, 0, 9, B, B + 0.4),
    span(door.x + door.width / 2, W, 0, 9, B, B + 0.4),
    span(door.x - door.width / 2, door.x + door.width / 2, door.height, 9, B, B + 0.4),
    // Les poteaux de la mezzanine.
    span(-2.35, -2.05, 0, LOFT, S - 0.15, S + 0.15),
    span(2.05, 2.35, 0, LOFT, S - 0.15, S + 0.15),
    // Le plancher de la mezzanine, et ses garde-corps.
    span(PLAN.stairEast, W, LOFT - 0.2, LOFT, S, B),
    span(-W, PLAN.stairEast, LOFT - 0.2, LOFT, S, st.zBottom),
    span(-W, PLAN.stairEast, LOFT - 0.2, LOFT, st.zTop, B),
    span(-W, W, LOFT, LOFT + 1.1, S - 0.05, S + 0.05),
    span(-W, PLAN.stairEast, LOFT, LOFT + 1.1, st.zBottom - 0.05, st.zBottom + 0.05),
    span(st.x1 - 0.06, st.x1 + 0.04, LOFT, LOFT + 1.1, st.zBottom, st.zBottom + 0.9),
    // La cuisine.
    span(k.tall.x0, k.run.x1, 0, k.run.top, zc, B),
    span(k.tall.x0, k.tall.x1, 0, k.tall.height, zc, B),
    span(is.x0 - 0.04, is.x1 + 0.04, 0, is.top, is.z0, is.z1 + 0.03),
    span(W - sb.depth - 0.03, W, 0, sb.top, sb.z0, sb.z1),
    // La bibliothèque de la mezzanine.
    span(-2.45, 2.45, LOFT, LOFT + 2.2, shelfZ, B)
  );

  return { meshes: kits.build(), solids };
}
