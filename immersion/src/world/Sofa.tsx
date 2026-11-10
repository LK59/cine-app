import { useMemo } from "react";
import { useLoader, useThree } from "@react-three/fiber";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { Material, Mesh, MeshStandardMaterial, Object3D, Texture } from "three";
import { assetUrl } from "../lib/assets";
import { useStore } from "../state/store";
import type { MaterialId } from "./geometry/types";
import { ktx2For } from "./ktx2";
import { bakedVariant, type Lightmaps } from "./lightmaps";
import { visibleGroups } from "./Parts";

/** Quelle matière pour quel maillage du modèle. */
const FABRICS: Record<string, MaterialId> = { sofa_frame: "fabric", sofa_cushions: "fabric", pillows_a: "pillowA", pillows_b: "pillowB", sofa_legs: "metal" };
/** Ce qu'un carreau de chaque tissu couvre, en mètres — les UV du modèle sont en mètres. */
const TILE: Partial<Record<MaterialId, number>> = { fabric: 0.55, pillowA: 0.4, pillowB: 0.3 };

const scaled = new WeakMap<Material, Material>();

/**
 * La même matière pour des UV en mètres : les textures de la matière d'origine sont partagées par
 * toute la maison (dont les UV sont déjà divisés par la taille du carreau) ; ici elles sont
 * dédoublées — sans recopier l'image — avec leur propre répétition.
 */
function metric(material: Material, tile: number): Material {
  const existing = scaled.get(material);
  if (existing) return existing;
  const source = material as MeshStandardMaterial;
  const variant = source.clone();
  const repeat = (texture: Texture | null) => {
    if (!texture) return null;
    const copy = texture.clone();
    copy.repeat.set(1 / tile, 1 / tile);
    copy.needsUpdate = true;
    return copy;
  };
  variant.map = repeat(source.map);
  variant.normalMap = repeat(source.normalMap);
  // Occlusion et rugosité viennent de la même image : une seule copie.
  const arm = repeat(source.aoMap);
  variant.aoMap = arm;
  variant.roughnessMap = arm;
  variant.onBeforeCompile = source.onBeforeCompile;
  variant.customProgramCacheKey = source.customProgramCacheKey;
  scaled.set(material, variant);
  return variant;
}

/**
 * Le canapé : un vrai modèle (`public/assets/models/sofa/`, généré par `tools/sofa/`) — coussins
 * d'assise bombés, dossiers souples, passepoil, plis légers, neuf coussins posés. Il reçoit le tissu
 * lin de la maison, et sa propre lightmap quand elle est cuite.
 */
export function Sofa({ materials, lightmaps }: { materials: Record<MaterialId, Material>; lightmaps: Lightmaps | null }) {
  const gl = useThree((s) => s.gl);
  const room = useStore((s) => s.room);
  const gltf = useLoader(GLTFLoader, assetUrl("models/sofa/sofa.gltf"), (loader) => {
    loader.setKTX2Loader(ktx2For(gl));
    loader.setMeshoptDecoder(MeshoptDecoder);
  });
  const object = useMemo(() => {
    const atlas = lightmaps?.atlases.sofa;
    gltf.scene.traverse((child: Object3D) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const id = FABRICS[mesh.name] ?? FABRICS[mesh.parent?.name ?? ""] ?? "fabric";
      let material = TILE[id] ? metric(materials[id], TILE[id]!) : materials[id];
      if (atlas && lightmaps && mesh.geometry.getAttribute("uv1")) material = bakedVariant(material, atlas.texture, lightmaps.range);
      mesh.material = material;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    return gltf.scene;
  }, [gltf, materials, lightmaps]);
  return <primitive object={object} visible={visibleGroups(room).salon} />;
}
