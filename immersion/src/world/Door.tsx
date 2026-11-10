import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { CuboidCollider, RigidBody, type RapierCollider } from "@react-three/rapier";
import type { Group, Material } from "three";
import { useStore } from "../state/store";
import type { MaterialId } from "./geometry/types";
import { glassMaterial } from "./glass";
import { DOOR, ROOM } from "./layout";
import { visibleGroups } from "./Parts";

/**
 * La porte-fenêtre de la terrasse : un vantail vitré qui coulisse vers l'est, derrière le vantail fixe.
 *
 * Seule pièce mobile de l'enveloppe : elle n'est pas dans la lumière cuite, et sa collision s'efface
 * quand elle est ouverte. Ouverte, le vent entre (`SoundScape`) et le son du salon sort.
 */
export function Door({ materials }: { materials: Record<MaterialId, Material> }) {
  const open = useStore((s) => s.door);
  const room = useStore((s) => s.room);
  const leaf = useRef<Group>(null);
  const collider = useRef<RapierCollider>(null);
  const slide = useRef(0);
  const glass = useMemo(() => glassMaterial(0.05, 0.6), []);
  useEffect(() => () => glass.dispose(), [glass]);

  const width = DOOR.x1 - DOOR.x0;
  const z = ROOM.north + 0.13 + 0.07;
  const frame = 0.055;

  useFrame((_, delta) => {
    // Le vantail glisse : vite au départ, doucement à l'arrivée.
    slide.current += ((open ? 1 : 0) - slide.current) * (1 - Math.exp(-Math.min(delta, 0.1) * 5));
    if (Math.abs((open ? 1 : 0) - slide.current) < 0.001) slide.current = open ? 1 : 0;
    if (leaf.current) leaf.current.position.x = DOOR.x0 + width / 2 + slide.current * DOOR.slide;
    // On passe dès que l'ouverture est plus large que les épaules.
    collider.current?.setEnabled(slide.current < 0.7);
  });

  return (
    <>
      <group ref={leaf} position={[DOOR.x0 + width / 2, 0, z]} visible={visibleGroups(room).salon} name="door">
        {/* Le cadre du vantail : deux montants, deux traverses. */}
        {[-1, 1].map((side) => (
          <mesh key={side} material={materials.timber} position={[side * (width / 2 - frame / 2), DOOR.height / 2 + 0.02, 0]}>
            <boxGeometry args={[frame, DOOR.height, 0.05]} />
          </mesh>
        ))}
        {[0.02 + frame / 2, DOOR.height + 0.02 - frame / 2].map((y) => (
          <mesh key={y} material={materials.timber} position={[0, y, 0]}>
            <boxGeometry args={[width, frame, 0.05]} />
          </mesh>
        ))}
        <mesh material={glass} position={[0, DOOR.height / 2 + 0.02, 0]} renderOrder={3}>
          <planeGeometry args={[width - frame * 2, DOOR.height - frame * 2]} />
        </mesh>
        {/* La poignée : une barre verticale, des deux côtés. */}
        <mesh material={materials.metal} position={[-width / 2 + 0.11, 1.05, 0]}>
          <boxGeometry args={[0.022, 0.42, 0.11]} />
        </mesh>
      </group>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider ref={collider} args={[width / 2, 1.15, 0.14]} position={[DOOR.x0 + width / 2, 1.15, ROOM.north + 0.1]} />
      </RigidBody>
    </>
  );
}
