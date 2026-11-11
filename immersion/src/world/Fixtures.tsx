import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, CylinderGeometry, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, SphereGeometry } from "three";
import { useStore } from "../state/store";
import { NIGHT_LAMPS } from "./geometry/night";
import { PORCH_LAMP } from "./geometry/outside";
import { PENDANTS, STAIR_SCONCES } from "./geometry/south";
import { LAMPS, TABLE } from "./layout";
import { lampLevels } from "./lampLevels";
import { visibleGroups } from "./Parts";

/**
 * Ce qui luit sans être une lumière : les abat-jour, les ampoules des suspensions, les appliques —
 * des matières émissives, que le halo ramasse — et les petits objets de verre et de papier de la
 * table basse. Les vraies lumières sont dans `Lights`.
 */
export function Fixtures() {
  const room = useStore((s) => s.room);
  const visible = visibleGroups(room);
  const m = useMemo(
    () => ({
      // L'abat-jour : un tissu clair éclairé de l'intérieur.
      shade: new MeshStandardMaterial({ color: "#f3e3c8", roughness: 0.9, emissive: new Color("#ffad5c"), emissiveIntensity: 0.85, side: DoubleSide }),
      // Les mêmes abat-jour dans la chambre : une matière à part, parce que leur lampe s'éteint à part.
      shadeNight: new MeshStandardMaterial({ color: "#f3e3c8", roughness: 0.9, emissive: new Color("#ffad5c"), emissiveIntensity: 0.85, side: DoubleSide }),
      bulb: new MeshStandardMaterial({ color: "#fff1d6", emissive: new Color("#ffc98a"), emissiveIntensity: 4 }),
      sconce: new MeshStandardMaterial({ color: "#f6e7cf", roughness: 0.8, emissive: new Color("#ffb568"), emissiveIntensity: 1.6, side: DoubleSide }),
      // Les appliques de l'escalier : la même, qui s'éteint avec les lampes de la cuisine et de la mezzanine.
      sconceSouth: new MeshStandardMaterial({ color: "#f6e7cf", roughness: 0.8, emissive: new Color("#ffb568"), emissiveIntensity: 1.6, side: DoubleSide }),
      glass: new MeshPhysicalMaterial({ color: "#ffffff", roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, envMapIntensity: 1.6, depthWrite: false, side: DoubleSide }),
      paper: [new MeshStandardMaterial({ color: "#6e2f24", roughness: 0.7 }), new MeshStandardMaterial({ color: "#d8cdb9", roughness: 0.8 }), new MeshStandardMaterial({ color: "#27333f", roughness: 0.7 })],
    }),
    []
  );
  // Ce qui luit suit le niveau de sa lampe (interrupteurs, mode cinéma) : éteint, un abat-jour n'émet rien.
  useFrame(() => {
    m.shade.emissiveIntensity = 0.85 * lampLevels.salon;
    m.shadeNight.emissiveIntensity = 0.85 * lampLevels.nuit;
    m.sconce.emissiveIntensity = 1.6 * lampLevels.nuit;
    m.sconceSouth.emissiveIntensity = 1.6 * lampLevels.sud;
    m.bulb.emissiveIntensity = 4 * lampLevels.sud;
  });
  const g = useMemo(
    () => ({
      shade: new CylinderGeometry(0.25, 0.3, 0.36, 40, 1, true),
      bedside: new CylinderGeometry(0.11, 0.15, 0.2, 28, 1, true),
      sconce: new CylinderGeometry(0.06, 0.08, 0.2, 20, 1, true),
      bulb: new SphereGeometry(0.035, 14, 10),
      bell: new CylinderGeometry(0.1, 0.1, 0.34, 32, 1, true),
    }),
    []
  );
  return (
    <group>
      <group visible={visible.salon}>
        {LAMPS.map(([x, z], i) => (
          <mesh key={i} geometry={g.shade} material={m.shade} position={[x, 1.56, z]} />
        ))}
        {/* Sur la table basse : une pile de livres, et la cloche de verre de la bougie. */}
        {[
          [0.34, 0.04, 0.25, 0],
          [0.3, 0.035, 0.22, 0.2],
          [0.27, 0.03, 0.2, -0.15],
        ].map(([w, h, d, r], i) => (
          <mesh key={i} material={m.paper[i]} position={[TABLE.x - 0.42, TABLE.h + 0.02 + i * 0.038, TABLE.z + 0.08]} rotation-y={r} castShadow>
            <boxGeometry args={[w, h, d]} />
          </mesh>
        ))}
        <mesh geometry={g.bell} material={m.glass} position={[TABLE.x + 0.1, TABLE.h + 0.17, TABLE.z + 0.02]} renderOrder={4} />
      </group>
      {STAIR_SCONCES.map(({ at, out }, i) => (
        <mesh key={`escalier-${i}`} geometry={g.sconce} material={m.sconceSouth} position={[at[0] + out[0] * 0.07, at[1], at[2] + out[2] * 0.07]} />
      ))}
      {PENDANTS.map(([x, y, z], i) => (
        <mesh key={i} geometry={g.bulb} material={m.bulb} position={[x, y + 0.03, z]} />
      ))}
      <group visible={visible.nuit}>
        {NIGHT_LAMPS.sconces.map(([x, y, z], i) => (
          <mesh key={i} geometry={g.sconce} material={m.sconce} position={[x, y, z - 0.07]} />
        ))}
        {NIGHT_LAMPS.screenSconces.map(([x, y, z], i) => (
          <mesh key={`tv-${i}`} geometry={g.sconce} material={m.sconce} position={[x, y, z]} />
        ))}
        {NIGHT_LAMPS.bedside.map(([x, y, z], i) => (
          <mesh key={i} geometry={g.bedside} material={m.shadeNight} position={[x, y, z]} />
        ))}
      </group>
      {/* La lanterne du dehors, près de la porte d'entrée : son verre dépoli, qui luit avec les lampes de la chambre. */}
      <mesh geometry={g.sconce} material={m.sconce} position={PORCH_LAMP} scale={[0.75, 1.2, 0.75]} visible={visible.dehors} />
    </group>
  );
}
