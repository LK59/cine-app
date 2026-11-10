import { useMemo } from "react";
import { DoubleSide, type Material } from "three";
import { useStore } from "../state/store";
import { buildNight } from "./geometry/night";
import { buildBlockSofa, buildSalon } from "./geometry/salon";
import { buildSouth } from "./geometry/south";
import type { GroupId, MaterialId, Part } from "./geometry/types";
import { useMaterials } from "./materials";
import { Solids } from "./Solids";

/** Les petites pièces sans ombre portée : elles n'y gagneraient rien, la carte d'ombre y perdrait. */
const NO_SHADOW = new Set<MaterialId>(["rug", "white"]);

function PartView({ part, materials, visible }: { part: Part; materials: Record<MaterialId, Material>; visible: boolean }) {
  return (
    <group visible={visible}>
      {(Object.keys(part.meshes) as MaterialId[]).map((id) => (
        <mesh key={id} geometry={part.meshes[id]} material={materials[id]} castShadow={!NO_SHADOW.has(id)} receiveShadow material-side={id === "planks" ? DoubleSide : undefined} name={`part-${id}`} />
      ))}
    </group>
  );
}

/**
 * Ce qui se dessine selon la pièce où l'on est : la pièce courante, et ce qui se voit par ses
 * ouvertures. Le salon, la cuisine et la mezzanine partagent un même volume ; la chambre ne voit du
 * reste que ce que laissent passer deux portes — le salon n'y est plus dessiné. De la mezzanine, la
 * partie nuit est derrière un mur plein.
 */
export function visibleGroups(room: string): Record<GroupId, boolean> {
  return { salon: room !== "chambre", sud: true, nuit: room !== "mezzanine" };
}

/**
 * Le chalet bâti : ses trois groupes de pièces, un maillage par matière dans chacun. La géométrie vient
 * de fonctions pures (`geometry/`) — les mêmes que lit l'outil de cuisson de la lumière.
 */
export function Parts({ blockSofa }: { blockSofa: boolean }) {
  const materials = useMaterials();
  const room = useStore((s) => s.room);
  const parts = useMemo(() => ({ salon: buildSalon(), sud: buildSouth(), nuit: buildNight() }), []);
  const sofa = useMemo(() => (blockSofa ? buildBlockSofa() : null), [blockSofa]);
  const visible = visibleGroups(room);
  return (
    <>
      {(Object.keys(parts) as GroupId[]).map((id) => (
        <group key={id} name={`group-${id}`}>
          <PartView part={parts[id]} materials={materials} visible={visible[id]} />
          {/* Les collisions, elles, ne dépendent pas de ce qui se dessine. */}
          <Solids solids={parts[id].solids} />
        </group>
      ))}
      {sofa ? <PartView part={sofa} materials={materials} visible={visible.salon} /> : null}
    </>
  );
}
