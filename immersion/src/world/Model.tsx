import { useMemo } from "react";
import { useLoader, useThree } from "@react-three/fiber";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { Mesh, Object3D, WebGLRenderer } from "three";
import { assetUrl, BASIS_PATH } from "../lib/assets";

/** Un chargeur KTX2 par moteur de rendu, partagé par tous les modèles. */
const ktx2Loaders = new WeakMap<WebGLRenderer, KTX2Loader>();
function ktx2For(gl: WebGLRenderer): KTX2Loader {
  let loader = ktx2Loaders.get(gl);
  if (!loader) {
    loader = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(gl);
    ktx2Loaders.set(gl, loader);
  }
  return loader;
}

export type ModelId =
  | "modern_arm_chair_01"
  | "mid_century_lounge_chair"
  | "Ottoman_01"
  | "side_table_01"
  | "potted_plant_01"
  | "potted_plant_02"
  | "ceramic_vase_01"
  | "ceramic_vase_03"
  | "wooden_bowl_01"
  | "Lantern_01"
  | "wooden_lantern_01"
  | "wooden_candlestick"
  | "mantel_clock_01"
  | "hanging_picture_frame_02"
  | "bar_chair_round_01"
  | "vintage_day_bed"
  | "ClassicNightstand_01"
  | "modern_coffee_table_01"
  | "modern_coffee_table_02";

interface ModelProps {
  id: ModelId;
  position?: [number, number, number];
  /** Rotation autour de la verticale, en radians. */
  turn?: number;
  scale?: number;
  /** Le modèle porte-t-il une ombre ? Les petits objets s'en passent. */
  shadow?: boolean;
}

/**
 * Un modèle de la bibliothèque d'assets (`public/assets/models/<id>/`) : un `.gltf` avec sa géométrie
 * compressée (meshopt) et ses textures KTX2 à côté — rien d'embarqué, la politique de sécurité de la
 * page refuse les `blob:` que three créerait pour un `.glb`.
 *
 * Chaque emploi reçoit sa propre copie de la hiérarchie ; géométries et matières restent partagées.
 */
export function Model({ id, position, turn = 0, scale = 1, shadow = true }: ModelProps) {
  const gl = useThree((s) => s.gl);
  const gltf = useLoader(GLTFLoader, assetUrl(`models/${id}/${id}.gltf`), (loader) => {
    loader.setKTX2Loader(ktx2For(gl));
    loader.setMeshoptDecoder(MeshoptDecoder);
  });
  const object = useMemo(() => {
    const copy = gltf.scene.clone(true);
    copy.traverse((child: Object3D) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
    });
    return copy;
  }, [gltf, shadow]);
  return <primitive object={object} position={position} rotation-y={turn} scale={scale} />;
}
