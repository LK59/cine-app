import { CuboidCollider, RigidBody } from "@react-three/rapier";
import type { Solid } from "./layout";

/** Les boîtes de collision d'un ensemble (une pièce, un meuble) : fixes, invisibles. */
export function Solids({ solids }: { solids: readonly Solid[] }) {
  return (
    <RigidBody type="fixed" colliders={false}>
      {solids.map((s, i) => (
        <CuboidCollider key={i} args={s.h} position={s.p} rotation={[0, s.ry ?? 0, 0]} />
      ))}
    </RigidBody>
  );
}
