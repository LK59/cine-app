import { Suspense, useMemo } from "react";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { attachLightmapUv, bakedVariant, useLightmaps, type Lightmaps } from "./lightmaps";
import { Sofa } from "./Sofa";
import { Door } from "./Door";
import { DoubleSide, type Material } from "three";
import { useStore } from "../state/store";
import { buildNight } from "./geometry/night";
import { buildBlockSofa, buildSalon } from "./geometry/salon";
import { buildSouth } from "./geometry/south";
import { buildOutside } from "./geometry/outside";
import { buildTerrace } from "./geometry/terrace";
import type { GroupId, MaterialId, Part } from "./geometry/types";
import { useMaterials } from "./materials";
import { Solids } from "./Solids";

/** Les petites pièces sans ombre portée : elles n'y gagneraient rien, la carte d'ombre y perdrait. */
const NO_SHADOW = new Set<MaterialId>(["rug", "white"]);

function PartView({ part, group, materials, visible, lightmaps }: { part: Part; group?: GroupId; materials: Record<MaterialId, Material>; visible: boolean; lightmaps?: Lightmaps | null }) {
  // Pour chaque maillage : sa matière, éclairée par la lightmap de son groupe quand ses UV de lumière
  // ont pu être posés (voir `attachLightmapUv`).
  const resolved = useMemo(() => {
    const atlas = group && lightmaps ? lightmaps.atlases[group] : undefined;
    return (Object.keys(part.meshes) as MaterialId[]).map((id) => {
      const geometry = part.meshes[id]!;
      const lit = atlas && attachLightmapUv(geometry, atlas.uvs.get(`${group}__${id}`));
      return { id, geometry, material: lit && group ? bakedVariant(materials[id], group, atlas) : materials[id] };
    });
  }, [part, group, materials, lightmaps]);
  return (
    <group visible={visible}>
      {resolved.map(({ id, geometry, material }) => (
        <mesh key={id} geometry={geometry} material={material} castShadow={!NO_SHADOW.has(id)} receiveShadow material-side={id === "planks" ? DoubleSide : undefined} name={`part-${id}`} />
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
  // Le dehors de l'aile de la chambre se voit par la fenêtre de la cuisine et celle de la chambre. Il est aussi
  // dessiné depuis la mezzanine (11/11/2026), par sécurité : on y voyait le ciel en points bleus par des fentes
  // entre le toit et le pignon. Ces fentes sont fermées dans la géométrie (`GABLE_TOP`) ; une qui resterait, vers
  // le bas, montrerait le toit de l'aile plutôt que le vide. Coût mesuré : rien de lisible (voir PROGRESS).
  return {
    salon: room !== "chambre",
    sud: true,
    nuit: room !== "mezzanine" && room !== "terrasse",
    terrasse: room !== "chambre" && room !== "couloir",
    dehors: room === "cuisine" || room === "chambre" || room === "salon" || room === "mezzanine",
  };
}

/**
 * Le chalet bâti : ses trois groupes de pièces, un maillage par matière dans chacun. La géométrie vient
 * de fonctions pures (`geometry/`) — les mêmes que lit l'outil de cuisson de la lumière.
 */
export function Parts() {
  const materials = useMaterials();
  const lightmaps = useLightmaps();
  const room = useStore((s) => s.room);
  const parts = useMemo(() => ({ salon: buildSalon(), sud: buildSouth(), nuit: buildNight(), terrasse: buildTerrace(), dehors: buildOutside() }), []);
  const visible = visibleGroups(room);
  return (
    <>
      {(Object.keys(parts) as GroupId[]).map((id) => (
        <group key={id} name={`group-${id}`}>
          <PartView part={parts[id]} group={id} materials={materials} visible={visible[id]} lightmaps={lightmaps} />
          {/* Les collisions, elles, ne dépendent pas de ce qui se dessine. */}
          <Solids solids={parts[id].solids} />
        </group>
      ))}
      <Door materials={materials} />
      {/* Le canapé : le modèle ; s'il ne se charge pas, sa version en boîtes tient sa place. */}
      <ErrorBoundary fallback={<BlockSofa materials={materials} visible={visible.salon} />}>
        <Suspense fallback={null}>
          <Sofa materials={materials} lightmaps={lightmaps} />
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

function BlockSofa({ materials, visible }: { materials: Record<MaterialId, Material>; visible: boolean }) {
  const part = useMemo(() => buildBlockSofa(), []);
  return <PartView part={part} materials={materials} visible={visible} />;
}
