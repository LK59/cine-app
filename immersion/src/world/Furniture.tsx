import { useMemo } from "react";
import { Color, CylinderGeometry, DoubleSide, LatheGeometry, MeshPhysicalMaterial, MeshStandardMaterial, Vector2 } from "three";
import { Kit } from "./build";
import { BREAST, CHANDELIER, LAMPS, ROOM, SOFA, TABLE, span, type Solid } from "./layout";
import { Solids } from "./Solids";
import { usePbr } from "./textures";

const { backX, frontX, wingEnd, z0, z1, depth } = SOFA;

/**
 * Les coussins décoratifs : où ils sont posés, vers où ils regardent (`yaw` : π/2 = vers la
 * télévision, 0 = vers le sud, π = vers le nord), de combien ils s'adossent, et lequel des deux tissus.
 */
const PILLOWS: { at: [number, number, number]; yaw: number; lean: number; spin: number; size: number; fabric: 0 | 1 }[] = [
  { at: [backX + 0.52, 0.71, z0 + 0.62], yaw: Math.PI / 2 - 0.5, lean: 0.34, spin: 0.08, size: 0.5, fabric: 1 },
  { at: [backX + 0.56, 0.69, z0 + 1.2], yaw: Math.PI / 2 - 0.1, lean: 0.4, spin: -0.06, size: 0.44, fabric: 0 },
  { at: [backX + 0.54, 0.7, -1.5 + 0.85], yaw: Math.PI / 2 + 0.15, lean: 0.36, spin: 0.05, size: 0.48, fabric: 1 },
  { at: [backX + 0.56, 0.69, z1 - 1.15], yaw: Math.PI / 2 + 0.1, lean: 0.4, spin: 0.07, size: 0.44, fabric: 0 },
  { at: [backX + 0.52, 0.71, z1 - 0.6], yaw: Math.PI / 2 + 0.5, lean: 0.34, spin: -0.08, size: 0.5, fabric: 1 },
  { at: [frontX + 0.75, 0.69, z0 + 0.54], yaw: 0.15, lean: 0.38, spin: 0.06, size: 0.46, fabric: 0 },
  { at: [wingEnd - 0.5, 0.69, z0 + 0.55], yaw: -0.3, lean: 0.36, spin: -0.05, size: 0.46, fabric: 1 },
  { at: [frontX + 0.95, 0.69, z1 - 0.54], yaw: Math.PI - 0.15, lean: 0.38, spin: 0.05, size: 0.46, fabric: 1 },
  { at: [wingEnd - 0.55, 0.69, z1 - 0.55], yaw: Math.PI + 0.3, lean: 0.36, spin: -0.07, size: 0.44, fabric: 0 },
];

/** Ce que le visiteur ne traverse pas : le canapé, la table, les poufs, les lampadaires. */
const SOLIDS: Solid[] = [
  span(backX - 0.05, frontX, 0, 0.95, z0, z1),
  span(frontX, wingEnd, 0, 0.95, z0, z0 + depth),
  span(frontX, wingEnd, 0, 0.95, z1 - depth, z1),
  span(TABLE.x - TABLE.w / 2, TABLE.x + TABLE.w / 2, 0, TABLE.h + 0.05, TABLE.z - TABLE.d / 2, TABLE.z + TABLE.d / 2),
  span(2.75, 3.65, 0, 0.42, -3.05, -2.15),
  span(2.75, 3.65, 0, 0.42, -0.85, 0.05),
  ...LAMPS.map(([x, z]) => span(x - 0.2, x + 0.2, 0, 1.8, z - 0.2, z + 0.2)),
];

/**
 * Le mobilier du salon, écrit en code : le canapé en U et ses coussins, le tapis, la table basse,
 * les poufs devant l'âtre, les lampadaires, le lustre.
 *
 * Des boîtes aux arêtes adoucies et de bons tissus : pour un canapé d'angle, c'est la matière et la
 * lumière qui font le volume, pas le nombre de triangles.
 */
export function Furniture() {
  const fabric = usePbr("fabric_sofa", { tint: "#e6dccb", bump: 1.4, env: 0.3, saturation: 0.7 });
  const pillowA = usePbr("fabric_pillow", { tint: "#b9a48c", bump: 1.3, env: 0.25 });
  const pillowB = usePbr("fabric_sofa", { tint: "#8d6f55", bump: 1.6, env: 0.25 });
  const rugMat = usePbr("rug", { tint: "#c9bba6", bump: 1.2, env: 0.2 });
  const leather = usePbr("leather", { tint: "#a8794f", roughness: 0.75, env: 0.7 });
  const wood = usePbr("wood_beam", { tint: "#8f7f73", roughness: 0.8, env: 0.7, saturation: 0.55 });

  const metal = useMemo(() => new MeshStandardMaterial({ color: "#0d0d0e", roughness: 0.48, metalness: 0.85, envMapIntensity: 0.9 }), []);
  // L'abat-jour : un tissu clair éclairé de l'intérieur.
  const shade = useMemo(() => new MeshStandardMaterial({ color: "#f3e3c8", roughness: 0.9, emissive: new Color("#ffad5c"), emissiveIntensity: 0.85, side: DoubleSide }), []);
  const glass = useMemo(() => new MeshPhysicalMaterial({ color: "#ffffff", roughness: 0.04, metalness: 0, transmission: 0, transparent: true, opacity: 0.16, envMapIntensity: 1.6, depthWrite: false, side: DoubleSide }), []);
  const paper = useMemo(() => [new MeshStandardMaterial({ color: "#6e2f24", roughness: 0.7 }), new MeshStandardMaterial({ color: "#d8cdb9", roughness: 0.8 }), new MeshStandardMaterial({ color: "#27333f", roughness: 0.7 })], []);

  const geometry = useMemo(() => {
    // ── Le canapé ─────────────────────────────────────────────────────────────
    const sofa = new Kit(0.55);
    const seatTop = 0.47;
    // Socles : un par côté du U.
    sofa.rounded([frontX - backX, 0.24, z1 - z0], 0.05, { at: [(backX + frontX) / 2, 0.19, (z0 + z1) / 2] });
    sofa.rounded([wingEnd - frontX, 0.24, depth], 0.05, { at: [(frontX + wingEnd) / 2, 0.19, z0 + depth / 2] });
    sofa.rounded([wingEnd - frontX, 0.24, depth], 0.05, { at: [(frontX + wingEnd) / 2, 0.19, z1 - depth / 2] });
    // Dossiers pleins, derrière les coussins.
    sofa.rounded([0.2, 0.78, z1 - z0], 0.07, { at: [backX + 0.1, 0.46, (z0 + z1) / 2] });
    sofa.rounded([wingEnd - backX, 0.78, 0.2], 0.07, { at: [(backX + wingEnd) / 2, 0.46, z0 + 0.1] });
    sofa.rounded([wingEnd - backX, 0.78, 0.2], 0.07, { at: [(backX + wingEnd) / 2, 0.46, z1 - 0.1] });
    // Accoudoirs, au bout des ailes.
    for (const z of [z0 + depth / 2, z1 - depth / 2]) sofa.rounded([0.22, 0.6, depth], 0.08, { at: [wingEnd + 0.03, 0.37, z] });
    // Assises du grand côté : cinq coussins, un joint entre chacun.
    const inner0 = z0 + 0.2;
    const inner1 = z1 - 0.2;
    const seats = 5;
    const seatW = (inner1 - inner0) / seats;
    for (let i = 0; i < seats; i++) {
      const z = inner0 + seatW * (i + 0.5);
      sofa.rounded([frontX - backX - 0.2, 0.2, seatW - 0.02], 0.07, { at: [(backX + 0.2 + frontX) / 2 + 0.02, seatTop - 0.1, z] });
      // Coussins de dossier, légèrement couchés.
      sofa.rounded([0.24, 0.5, seatW - 0.03], 0.1, { at: [backX + 0.34, seatTop + 0.22, z], rot: [0, 0, 0.16] });
    }
    // Assises et dossiers des ailes : trois coussins chacune.
    for (const [edge, dir] of [
      [z0, 1],
      [z1, -1],
    ] as const) {
      const wingSeats = 3;
      const w = (wingEnd - frontX) / wingSeats;
      for (let i = 0; i < wingSeats; i++) {
        const x = frontX + w * (i + 0.5);
        sofa.rounded([w - 0.02, 0.2, depth - 0.2], 0.07, { at: [x, seatTop - 0.1, edge + dir * (0.2 + (depth - 0.2) / 2 + 0.02)] });
        sofa.rounded([w - 0.03, 0.5, 0.24], 0.1, { at: [x, seatTop + 0.22, edge + dir * 0.34], rot: [dir * -0.16, 0, 0] });
      }
    }

    // ── Les coussins décoratifs, par tissu ────────────────────────────────────
    const cushions = [new Kit(0.4), new Kit(0.3)];
    for (const p of PILLOWS) cushions[p.fabric].rounded([p.size, p.size, 0.19], 0.09, { at: p.at, rot: [-p.lean, p.yaw, p.spin], order: "YXZ" });

    // ── Le tapis ──────────────────────────────────────────────────────────────
    const rug = new Kit(0.9).rounded([6.3, 0.028, 6.0], 0.012, { at: [-0.35, 0.014, -1.5] });

    // ── Les poufs de cuir, devant l'âtre ──────────────────────────────────────
    const poufs = new Kit(0.7);
    poufs.rounded([0.9, 0.34, 0.9], 0.09, { at: [3.2, 0.25, -2.6] });
    poufs.rounded([0.9, 0.34, 0.9], 0.09, { at: [3.2, 0.25, -0.4] });

    // ── Le bois des meubles : plateau de la table, pieds des poufs ─────────────
    const woods = new Kit(1.1);
    woods.rounded([TABLE.w, 0.07, TABLE.d], 0.012, { at: [TABLE.x, TABLE.h - 0.035, TABLE.z] }, 0);
    woods.rounded([TABLE.w - 0.2, 0.03, TABLE.d - 0.16], 0.008, { at: [TABLE.x, 0.13, TABLE.z] }, 0);
    for (const [x, z] of [
      [3.2, -2.6],
      [3.2, -0.4],
    ]) {
      woods.box([0.8, 0.07, 0.8], { at: [x, 0.045, z] }, 0);
    }
    // Les guéridons à côté des lampadaires.
    for (const [x, z] of LAMPS) woods.add(new CylinderGeometry(0.27, 0.27, 0.045, 28), { at: [x + 0.62, 0.56, z] }, 0);

    // ── Le métal noir : piètement de la table, lampadaires, lustre ─────────────
    const metals = new Kit(1);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        metals.box([0.035, TABLE.h - 0.07, 0.035], { at: [TABLE.x + sx * (TABLE.w / 2 - 0.06), (TABLE.h - 0.07) / 2, TABLE.z + sz * (TABLE.d / 2 - 0.06)] });
      }
    for (const [x, z] of LAMPS) {
      metals.add(new CylinderGeometry(0.17, 0.19, 0.03, 24), { at: [x, 0.015, z] });
      metals.add(new CylinderGeometry(0.014, 0.014, 1.42, 10), { at: [x, 0.74, z] });
      // Le guéridon : un fût et un pied.
      metals.add(new CylinderGeometry(0.018, 0.018, 0.54, 10), { at: [x + 0.62, 0.27, z] });
      metals.add(new CylinderGeometry(0.16, 0.17, 0.02, 20), { at: [x + 0.62, 0.01, z] });
    }
    // Le lustre : deux anneaux plats, leurs coupelles, leurs tiges jusqu'au faîtage.
    const { x: cx, z: cz, y: cy, r1, r2, rise } = CHANDELIER;
    const band = (radius: number) => new LatheGeometry([new Vector2(radius - 0.035, -0.06), new Vector2(radius + 0.035, -0.06), new Vector2(radius + 0.035, 0.06), new Vector2(radius - 0.035, 0.06), new Vector2(radius - 0.035, -0.06)], 72);
    metals.add(band(r1), { at: [cx, cy, cz] });
    metals.add(band(r2), { at: [cx, cy + rise, cz] });
    const hub: [number, number, number] = [cx, ROOM.ridge - 0.5, cz];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      const inner: [number, number, number] = [cx + Math.cos(a) * r2, cy + rise, cz + Math.sin(a) * r2];
      metals.beam([cx + Math.cos(a) * r1, cy, cz + Math.sin(a) * r1], inner, 0.016, 0.016);
      metals.beam(inner, hub, 0.016, 0.016);
    }
    metals.add(new CylinderGeometry(0.09, 0.05, 0.14, 16), { at: [hub[0], hub[1] + 0.05, hub[2]] });

    return { sofa: sofa.build(), cushionA: cushions[0].build(), cushionB: cushions[1].build(), rug: rug.build(), poufs: poufs.build(), woods: woods.build(), metals: metals.build() };
  }, []);

  const shadeGeometry = useMemo(() => new CylinderGeometry(0.25, 0.3, 0.36, 40, 1, true), []);
  const bellGeometry = useMemo(() => new CylinderGeometry(0.1, 0.1, 0.34, 32, 1, true), []);

  return (
    <group>
      <mesh geometry={geometry.sofa} material={fabric} castShadow receiveShadow />
      <mesh geometry={geometry.cushionA} material={pillowA} castShadow receiveShadow />
      <mesh geometry={geometry.cushionB} material={pillowB} castShadow receiveShadow />
      <mesh geometry={geometry.rug} material={rugMat} receiveShadow />
      <mesh geometry={geometry.poufs} material={leather} castShadow receiveShadow />
      <mesh geometry={geometry.woods} material={wood} castShadow receiveShadow />
      <mesh geometry={geometry.metals} material={metal} castShadow />
      {LAMPS.map(([x, z], i) => (
        <mesh key={i} geometry={shadeGeometry} material={shade} position={[x, 1.56, z]} />
      ))}
      {/* Sur la table basse : une pile de livres, et la cloche de verre de la bougie. */}
      {[
        [0.34, 0.04, 0.25, 0],
        [0.3, 0.035, 0.22, 0.2],
        [0.27, 0.03, 0.2, -0.15],
      ].map(([w, h, d, r], i) => (
        <mesh key={i} material={paper[i]} position={[TABLE.x - 0.42, TABLE.h + 0.02 + i * 0.038, TABLE.z + 0.08]} rotation-y={r} castShadow>
          <boxGeometry args={[w, h, d]} />
        </mesh>
      ))}
      <mesh geometry={bellGeometry} material={glass} position={[TABLE.x + 0.1, TABLE.h + 0.17, TABLE.z + 0.02]} renderOrder={4} />
      <Solids solids={SOLIDS} />
    </group>
  );
}

/** Le manteau reçoit quelques objets : pour l'instant, rien que ses bougies (`candles.ts`). */
export const MANTEL_Y = 1.0;
export const HEARTH = { x: BREAST.face - 0.33, y: 0.44 };
