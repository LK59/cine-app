import { useMemo } from "react";
import { DoubleSide, MeshStandardMaterial } from "three";
import { Kit } from "./build";
import { BREAST, ROOF_ANGLE, ROOM, TRUSSES, TV, roofY, span, type Solid } from "./layout";
import { Solids } from "./Solids";
import { usePbr } from "./textures";

const W = ROOM.halfW;
const N = ROOM.north;
const S = ROOM.south;
const B = ROOM.back;

/** Les trois fenêtres du mur ouest : leur centre le long du mur. */
export const WEST_WINDOWS = [-5.62, -2.88, -0.12] as const;
export const WEST_WINDOW = { width: 1.5, sill: 0.95, top: 3.45 } as const;

/** Les poteaux de la baie nord, d'ouest en est. */
export const BAY_POSTS = [-W + 0.14, -3.3, -1.1, 1.1, 3.3, W - 0.14] as const;

/** Les collisions de l'enveloppe : sol, murs, massif de pierre, banc de l'âtre. */
const SOLIDS: Solid[] = [
  span(-40, 40, -1, 0, -40, 40),
  span(-W - 0.4, -W, 0, 9, N, B),
  span(W, W + 0.4, 0, 9, N, B),
  span(-W, W, 0, 9, N - 0.4, N + 0.06),
  span(-W, W, 0, 9, B, B + 0.4),
  // Le massif de pierre et le banc de l'âtre à son pied.
  span(BREAST.face, W, 0, 5, BREAST.z0, BREAST.z1),
  span(BREAST.face - 0.66, BREAST.face, 0, 0.46, BREAST.z0 - 0.2, BREAST.z1 + 0.2),
  // Les poteaux qui avancent dans la pièce, au droit des fermes (côté ouest) et de la mezzanine.
  ...TRUSSES.map((z) => span(-W, -W + 0.3, 0, 4.6, z - 0.15, z + 0.15)),
  span(-2.35, -2.05, 0, ROOM.loft, S - 0.15, S + 0.15),
  span(2.05, 2.35, 0, ROOM.loft, S - 0.15, S + 0.15),
];

/**
 * L'enveloppe du salon : sol, murs, massif de pierre de la télévision, charpente et plafond.
 *
 * Tout est écrit en code, à partir du plan (`layout.ts`) : aucune maquette à charger, et chaque
 * dimension se règle à un seul endroit. Six maillages en tout — un par matière.
 */
export function Shell() {
  const floorMat = usePbr("wood_floor", { roughness: 0.6, env: 1.1, tint: "#b5a698", saturation: 0.7 });
  const timberMat = usePbr("wood_beam", { tint: "#9c8f84", roughness: 1.05, bump: 1.2, env: 0.5, saturation: 0.5 });
  const ceilingMat = usePbr("wood_planks_ceiling", { tint: "#b79f8a", env: 0.4, saturation: 0.85 });
  const stoneMat = usePbr("stone_wall", { bump: 1.6, env: 0.35 });
  const slabMat = usePbr("stone_slab", { tint: "#9c948c", roughness: 0.9, env: 0.5 });
  const plasterMat = usePbr("plaster", { tint: "#e9dcc6", env: 0.35 });

  const geometry = useMemo(() => {
    // ── Le sol : des lames qui filent vers la baie ────────────────────────────
    const floor = new Kit(2.6).span(-W, W, -0.06, 0, N, B, 2);

    // ── La pierre : le mur est en entier, et le massif qui porte la télévision ─
    const stone = new Kit(2.3);
    stone.span(W, W + 0.3, 0, ROOM.eave + 0.2, N, B);
    const tvZ0 = TV.z - TV.width / 2 - 0.05;
    const tvZ1 = TV.z + TV.width / 2 + 0.05;
    const tvY0 = TV.y - TV.height / 2 - 0.05;
    const tvY1 = TV.y + TV.height / 2 + 0.05;
    const top = roofY(BREAST.face) + 0.06;
    stone.span(BREAST.face, W, 0, top, BREAST.z0, tvZ0);
    stone.span(BREAST.face, W, 0, top, tvZ1, BREAST.z1);
    stone.span(BREAST.face, W, 0, tvY0, tvZ0, tvZ1);
    stone.span(BREAST.face, W, tvY1, top, tvZ0, tvZ1);
    // Le fond de la niche, derrière la dalle.
    stone.span(TV.x + 0.06, W, tvY0, tvY1, tvZ0, tvZ1);
    // Le socle du banc de l'âtre.
    stone.span(BREAST.face - 0.6, BREAST.face, 0, 0.38, BREAST.z0 - 0.15, BREAST.z1 + 0.15);

    // ── La dalle du banc ──────────────────────────────────────────────────────
    const slab = new Kit(1.6).span(BREAST.face - 0.66, BREAST.face, 0.38, 0.44, BREAST.z0 - 0.2, BREAST.z1 + 0.2);

    // ── L'enduit : le mur ouest autour de ses fenêtres, et la partie sud ───────
    const plaster = new Kit(2.2);
    const ww = WEST_WINDOW;
    let from: number = N;
    for (const z of WEST_WINDOWS) {
      plaster.span(-W - 0.3, -W, 0, ROOM.eave + 0.2, from, z - ww.width / 2);
      plaster.span(-W - 0.3, -W, 0, ww.sill, z - ww.width / 2, z + ww.width / 2);
      plaster.span(-W - 0.3, -W, ww.top, ROOM.eave + 0.2, z - ww.width / 2, z + ww.width / 2);
      from = z + ww.width / 2;
    }
    plaster.span(-W - 0.3, -W, 0, ROOM.eave + 0.2, from, B);
    // Le pignon du fond, jusqu'au faîtage : une suite de bandes qui suivent la pente.
    for (let x = -W; x < W - 0.01; x += 0.5) {
      plaster.span(x, x + 0.5, 0, Math.min(roofY(x), roofY(x + 0.5)) + 0.25, B, B + 0.3);
    }

    // ── Le bois : la charpente, les poteaux, les encadrements ──────────────────
    const timber = new Kit(1.5);
    const ridgeY = ROOM.ridge - 0.22;
    timber.beam([0, ridgeY, N - 0.3], [0, ridgeY, B], 0.28, 0.36);
    for (const side of [-1, 1]) {
      // Sablière en tête de mur, panne à mi-pente.
      timber.beam([side * (W - 0.16), ROOM.eave - 0.14, N], [side * (W - 0.16), ROOM.eave - 0.14, B], 0.3, 0.28);
      const px = side * 2.9;
      timber.beam([px, roofY(px) - 0.16, N], [px, roofY(px) - 0.16, B], 0.2, 0.26);
      // Chevrons, d'un bout à l'autre de la maison.
      for (let z = N + 0.35; z < B; z += 0.6875) {
        timber.beam([side * (W - 0.05), ROOM.eave - 0.04, z], [side * 0.14, roofY(0.14) - 0.09, z], 0.09, 0.15);
      }
    }
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
    // La mezzanine : sa poutre de rive, ses poteaux, son garde-corps.
    timber.beam([-W, ROOM.loft - 0.17, S], [W, ROOM.loft - 0.17, S], 0.3, 0.34);
    for (const x of [-W + 0.15, -2.2, 2.2, W - 0.15]) timber.span(x - 0.15, x + 0.15, 0, ROOM.loft - 0.34, S - 0.15, S + 0.15, 1);
    timber.beam([-W, ROOM.loft + 1.02, S], [W, ROOM.loft + 1.02, S], 0.09, 0.07);
    for (let x = -W + 0.12; x < W; x += 0.135) timber.span(x - 0.016, x + 0.016, ROOM.loft, ROOM.loft + 1.0, S - 0.016, S + 0.016, 1);
    // Solives sous la mezzanine.
    for (let x = -W + 0.5; x < W; x += 0.9) timber.beam([x, ROOM.loft - 0.14, S], [x, ROOM.loft - 0.14, B], 0.12, 0.2);
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
    timber.beam([-W, 0.14, zb], [W, 0.14, zb], 0.26, 0.28);
    timber.beam([-W, 3.2, zb], [W, 3.2, zb], 0.22, 0.2);
    timber.beam([-W, ROOM.eave - 0.02, zb], [W, ROOM.eave - 0.02, zb], 0.26, 0.26);
    for (const side of [-1, 1]) timber.beam([side * (W - 0.1), ROOM.eave + 0.02, zb], [side * 0.05, ROOM.ridge - 0.34, zb], 0.22, 0.24);
    for (let i = 0; i < BAY_POSTS.length - 1; i++) {
      const x0 = BAY_POSTS[i] + 0.13;
      const x1 = BAY_POSTS[i + 1] - 0.13;
      const mid = (x0 + x1) / 2;
      // En bas : de grands vitrages, une seule traverse.
      timber.beam([x0, 2.25, zb], [x1, 2.25, zb], 0.05, 0.05);
      timber.span(mid - 0.025, mid + 0.025, 0.28, 3.1, zb - 0.025, zb + 0.025, 1);
      // Au-dessus : les petits carreaux.
      timber.beam([x0, 3.92, zb], [x1, 3.92, zb], 0.045, 0.045);
      for (const t of [1 / 3, 2 / 3]) {
        const x = x0 + (x1 - x0) * t;
        timber.span(x - 0.022, x + 0.022, 3.3, ROOM.eave - 0.15, zb - 0.022, zb + 0.022, 1);
      }
      // Dans le pignon : montants jusqu'au toit, et deux traverses là où la hauteur le permet.
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

    // ── Le plafond : des lames sous les chevrons, et sous la mezzanine ─────────
    const ceiling = new Kit(1.9);
    const slopeLength = Math.hypot(W + 0.4, (W + 0.4) * Math.tan(ROOF_ANGLE));
    for (const side of [-1, 1]) {
      const cx = (side * (W + 0.4)) / 2;
      ceiling.box([slopeLength, 0.05, B - N + 0.8], { at: [cx, roofY(cx) + 0.09, (N + B) / 2 - 0.1], rot: [0, 0, -side * ROOF_ANGLE] }, 2);
    }
    ceiling.span(-W, W, ROOM.loft - 0.03, ROOM.loft + 0.03, S, B, 0);

    return { floor: floor.build(), stone: stone.build(), slab: slab.build(), plaster: plaster.build(), timber: timber.build(), ceiling: ceiling.build() };
  }, []);

  // La dalle de la télévision, éteinte : un noir brillant, où se reflète la pièce.
  const screenOff = useMemo(() => new MeshStandardMaterial({ color: "#010101", roughness: 0.05, metalness: 0, envMapIntensity: 3 }), []);
  const bezel = useMemo(() => new MeshStandardMaterial({ color: "#0b0b0c", roughness: 0.45, metalness: 0.7 }), []);

  return (
    <group>
      <mesh geometry={geometry.floor} material={floorMat} receiveShadow />
      <mesh geometry={geometry.stone} material={stoneMat} receiveShadow castShadow />
      <mesh geometry={geometry.slab} material={slabMat} receiveShadow castShadow />
      <mesh geometry={geometry.plaster} material={plasterMat} receiveShadow />
      <mesh geometry={geometry.timber} material={timberMat} receiveShadow castShadow />
      <mesh geometry={geometry.ceiling} material={ceilingMat} material-side={DoubleSide} receiveShadow castShadow />
      {/* Le cadre de l'écran : quatre baguettes noires autour de la dalle. */}
      <group position={[TV.x, TV.y, TV.z]} rotation-y={-Math.PI / 2} name="tv">
        <mesh name="tv-screen" material={screenOff}>
          <planeGeometry args={[TV.width, TV.height]} />
        </mesh>
        {[
          [0, TV.height / 2 + 0.014, TV.width + 0.056, 0.028],
          [0, -TV.height / 2 - 0.014, TV.width + 0.056, 0.028],
          [TV.width / 2 + 0.014, 0, 0.028, TV.height],
          [-TV.width / 2 - 0.014, 0, 0.028, TV.height],
        ].map(([x, y, w, h], i) => (
          <mesh key={i} position={[x, y, 0.012]} material={bezel}>
            <boxGeometry args={[w, h, 0.05]} />
          </mesh>
        ))}
      </group>
      <Solids solids={SOLIDS} />
    </group>
  );
}
