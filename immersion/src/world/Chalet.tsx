import { ROOM, TV, span, type Solid } from "./layout";
import { Solids } from "./Solids";

/** L'enveloppe du salon : le sol, les quatre murs. Les meubles ajoutent les leurs. */
const SHELL: Solid[] = [
  span(-30, 30, -1, 0, -30, 30),
  span(-ROOM.halfW - ROOM.wall, -ROOM.halfW, 0, ROOM.ridge, ROOM.north, ROOM.south),
  span(ROOM.halfW, ROOM.halfW + ROOM.wall, 0, ROOM.ridge, ROOM.north, ROOM.south),
  span(-ROOM.halfW, ROOM.halfW, 0, ROOM.ridge, ROOM.north - ROOM.wall, ROOM.north),
  span(-ROOM.halfW, ROOM.halfW, 0, ROOM.ridge, ROOM.south, ROOM.south + ROOM.wall),
];

/**
 * Le chalet. À cette étape : une pièce provisoire, aux bonnes dimensions, pour régler les
 * déplacements et les collisions. Le salon lui-même arrive à l'étape suivante.
 */
export function Chalet() {
  const w = ROOM.halfW * 2;
  const d = ROOM.south - ROOM.north;
  const cz = (ROOM.south + ROOM.north) / 2;
  return (
    <group>
      <ambientLight intensity={0.5} color="#ffd9a8" />
      <pointLight position={[0, 5, -1.5]} intensity={60} color="#ffb060" distance={18} decay={2} />
      <mesh rotation-x={-Math.PI / 2} position={[0, 0, cz]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#3a2a1e" roughness={0.7} />
      </mesh>
      <mesh position={[0, ROOM.eave / 2, ROOM.north]}>
        <planeGeometry args={[w, ROOM.eave]} />
        <meshStandardMaterial color="#223a5c" roughness={0.9} />
      </mesh>
      <mesh position={[ROOM.halfW, ROOM.eave / 2, cz]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[d, ROOM.eave]} />
        <meshStandardMaterial color="#6b6259" roughness={0.95} />
      </mesh>
      <mesh position={[-ROOM.halfW, ROOM.eave / 2, cz]} rotation-y={Math.PI / 2}>
        <planeGeometry args={[d, ROOM.eave]} />
        <meshStandardMaterial color="#d9cdb8" roughness={0.95} />
      </mesh>
      <mesh position={[0, ROOM.eave / 2, ROOM.south]} rotation-y={Math.PI}>
        <planeGeometry args={[w, ROOM.eave]} />
        <meshStandardMaterial color="#d9cdb8" roughness={0.95} />
      </mesh>
      <mesh position={[TV.x, TV.y, TV.z]} rotation-y={-Math.PI / 2}>
        <planeGeometry args={[TV.width, TV.height]} />
        <meshStandardMaterial color="#050506" roughness={0.15} metalness={0.2} />
      </mesh>
      <Solids solids={SHELL} />
    </group>
  );
}
