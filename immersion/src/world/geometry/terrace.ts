import { CylinderGeometry, RingGeometry, SphereGeometry, type BufferGeometry } from "three";
import { DOOR, ROOM, TERRACE, TUB, span, type Solid } from "../layout";
import { Kits } from "./envelope";
import type { Part } from "./types";

/** Retourne une surface vers son dedans : ses faces (par symétrie) **et** ses normales — sans quoi elle s'éclaire à l'envers. */
function inward<T extends BufferGeometry>(geometry: T): T {
  geometry.scale(-1, 1, 1);
  const normal = geometry.getAttribute("normal");
  for (let i = 0; i < normal.count; i++) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  return geometry;
}

/**
 * La terrasse : un platelage de plain-pied devant la baie, son garde-corps coiffé de neige, des
 * congères dans les angles, et le bain nordique — une cuve ronde en douves de bois, cerclée de fer,
 * avec ses deux marches.
 *
 * Géométrie fixe, comme les pièces : la même fonction sert au rendu et à la cuisson de la lumière (la
 * lune, le ciel, et la lumière du salon qui sort par la baie, avec l'ombre de ses poteaux).
 */
export function buildTerrace(): Part {
  const kits = new Kits();
  const timber = kits.get("timber");
  const planks = kits.get("planks");
  const wood = kits.get("wood");
  const metal = kits.get("metal");
  const snow = kits.get("snow");
  const { x0, x1, z0, z1, rail } = TERRACE;

  // ── Le platelage : des lames dans le sens de la sortie, une rive tout autour ─────────────────
  planks.span(x0, x1, -0.07, 0, z0, z1, 2);
  timber.beam([x0, -0.13, z0], [x1, -0.13, z0], 0.1, 0.26);
  for (const x of [x0, x1]) timber.beam([x, -0.13, z0], [x, -0.13, z1], 0.1, 0.26);
  // Les poteaux qui la portent, côté vallée (le terrain plonge dessous).
  for (const x of [x0 + 0.1, (x0 + x1) / 2, x1 - 0.1]) timber.span(x - 0.09, x + 0.09, -3.2, -0.2, z0 + 0.02, z0 + 0.2, 1);

  // ── Le garde-corps : poteaux, main courante, trois lisses de métal ───────────────────────────
  const posts: [number, number][] = [];
  const along = (from: [number, number], to: [number, number], count: number) => {
    for (let i = 0; i <= count; i++) posts.push([from[0] + ((to[0] - from[0]) * i) / count, from[1] + ((to[1] - from[1]) * i) / count]);
  };
  along([x0 + 0.06, z0 + 0.06], [x1 - 0.06, z0 + 0.06], 6);
  along([x0 + 0.06, z0 + 0.06], [x0 + 0.06, z1 - 0.1], 3);
  along([x1 - 0.06, z0 + 0.06], [x1 - 0.06, z1 - 0.1], 3);
  for (const [x, z] of posts) timber.span(x - 0.05, x + 0.05, 0, rail, z - 0.05, z + 0.05, 1);
  const runs: [[number, number], [number, number]][] = [
    [
      [x0 + 0.06, z0 + 0.06],
      [x1 - 0.06, z0 + 0.06],
    ],
    [
      [x0 + 0.06, z0 + 0.06],
      [x0 + 0.06, z1 - 0.1],
    ],
    [
      [x1 - 0.06, z0 + 0.06],
      [x1 - 0.06, z1 - 0.1],
    ],
  ];
  for (const [a, b] of runs) {
    timber.beam([a[0], rail + 0.03, a[1]], [b[0], rail + 0.03, b[1]], 0.13, 0.06);
    for (const y of [0.28, 0.54, 0.8]) metal.beam([a[0], y, a[1]], [b[0], y, b[1]], 0.016, 0.016);
    // La neige tenue sur la main courante : un bourrelet arrondi.
    const lengthwise = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.1;
    snow.rounded(lengthwise ? [length, 0.09, 0.17] : [0.17, 0.09, length], 0.04, { at: [(a[0] + b[0]) / 2, rail + 0.1, (a[1] + b[1]) / 2] });
  }

  // ── La neige au sol : balayée devant la porte, restée dans les angles et le long du garde-corps ──
  const drifts: [number, number, number, number, number][] = [
    [x0 + 0.75, z0 + 0.7, 1.5, 1.4, 0.2],
    [x0 + 0.45, z0 + 2.6, 0.9, 2.2, 0.13],
    [-2.4, z0 + 0.45, 3.2, 0.9, 0.12],
    [0.7, z0 + 0.4, 2.4, 0.8, 0.1],
    [x1 - 0.5, z1 - 0.7, 1.0, 1.3, 0.16],
    [x0 + 0.55, z1 - 0.5, 1.1, 0.9, 0.14],
  ];
  // Des dômes très aplatis, à demi enfouis : un tas de neige n'a pas d'arête.
  for (const [x, z, w, d, h] of drifts) snow.add(new SphereGeometry(1, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(w / 2, h, d / 2), { at: [x, -0.005, z] });

  // ── Le bain : des douves, deux cercles de fer, une margelle, deux marches ────────────────────
  const { radius, height } = TUB;
  timber.add(new CylinderGeometry(radius, radius, height, 44, 1, true), { at: [TUB.x, height / 2, TUB.z] }, 1);
  // L'intérieur : la même paroi, tournée vers le dedans.
  wood.add(inward(new CylinderGeometry(radius - 0.07, radius - 0.07, height, 44, 1, true)), { at: [TUB.x, height / 2, TUB.z] }, 1);
  wood.add(new RingGeometry(radius - 0.08, radius + 0.03, 48).rotateX(-Math.PI / 2), { at: [TUB.x, height, TUB.z] });
  for (const y of [0.2, height - 0.2]) metal.add(new CylinderGeometry(radius + 0.006, radius + 0.006, 0.045, 44, 1, true), { at: [TUB.x, y, TUB.z] });
  // Le banc immergé, dont on ne voit que le bord sous l'eau.
  wood.add(new RingGeometry(radius - 0.45, radius - 0.08, 40).rotateX(-Math.PI / 2), { at: [TUB.x, 0.38, TUB.z] });
  // Les marches, côté maison.
  const sx = TUB.x - 0.2;
  const sz = TUB.z + radius + 0.34;
  timber.span(sx - 0.45, sx + 0.45, 0, 0.26, sz - 0.02, sz + 0.34, 0);
  timber.span(sx - 0.45, sx + 0.45, 0, 0.52, sz - 0.34, sz - 0.02, 0);
  // Un peu de neige sur la margelle, du côté d'où vient le vent.
  snow.rounded([0.9, 0.08, 0.22], 0.035, { at: [TUB.x + 0.2, height + 0.04, TUB.z - radius + 0.02] });

  const solids: Solid[] = [
    // Le garde-corps, sur trois côtés.
    span(x0 - 0.3, x1 + 0.3, 0, 1.3, z0 - 0.3, z0 + 0.12),
    span(x0 - 0.3, x0 + 0.12, 0, 1.3, z0, z1),
    span(x1 - 0.12, x1 + 0.3, 0, 1.3, z0, z1),
    // Le bain et ses marches.
    span(TUB.x - radius * 0.92, TUB.x + radius * 0.92, 0, height + 0.1, TUB.z - radius * 0.92, TUB.z + radius * 0.92),
    span(sx - 0.45, sx + 0.45, 0, 0.5, sz - 0.34, sz + 0.34),
  ];
  // La terrasse ne se referme pas sur la maison : c'est la baie (et sa porte) qui fait la limite.
  void ROOM;
  void DOOR;
  return { meshes: kits.build(), solids };
}
