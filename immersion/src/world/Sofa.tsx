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

/**
 * Le plaid : la laine du coussin sombre, tissée d'un tartan — de larges bandes rouge sombre et vert de
 * nuit, croisées, et un filet crème. Le motif suit les UV du tissu (en mètres), donc ses plis.
 */
function tartan(material: Material, tile: number): Material {
  const variant = metric(material, tile).clone() as MeshStandardMaterial;
  const before = material.onBeforeCompile;
  variant.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
      {
        // En mètres le long du tissu.
        vec2 m = vMapUv * ${tile.toFixed(3)};
        vec2 band = step( 0.5, fract( m / 0.22 ) );
        vec2 line = smoothstep( 0.035, 0.02, abs( fract( m / 0.22 + 0.25 ) - 0.5 ) );
        vec3 red = vec3( 0.42, 0.05, 0.04 );
        vec3 green = vec3( 0.04, 0.13, 0.09 );
        vec3 weave = mix( red, green, band.x * 0.75 );
        weave = mix( weave, weave * 0.45, band.y * 0.6 );
        weave = mix( weave, vec3( 0.86, 0.8, 0.62 ), max( line.x, line.y ) * 0.7 );
        // La texture garde son grain (sa valeur), le tartan donne la couleur.
        float grain = dot( diffuseColor.rgb, vec3( 0.3333 ) );
        diffuseColor.rgb = weave * ( 0.55 + grain * 1.6 );
      }`
    );
  };
  const key = material.customProgramCacheKey();
  variant.customProgramCacheKey = () => `${key}|tartan`;
  return variant;
}

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
  const plaid = useMemo(() => tartan(materials.pillowB, 0.3), [materials]);
  const object = useMemo(() => {
    const atlas = lightmaps?.atlases.sofa;
    gltf.scene.traverse((child: Object3D) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const id = FABRICS[mesh.name] ?? FABRICS[mesh.parent?.name ?? ""] ?? "fabric";
      let material = mesh.name === "plaid" || mesh.parent?.name === "plaid" ? plaid : TILE[id] ? metric(materials[id], TILE[id]!) : materials[id];
      if (atlas && mesh.geometry.getAttribute("uv1")) material = bakedVariant(material, "sofa", atlas);
      mesh.material = material;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    return gltf.scene;
  }, [gltf, materials, lightmaps, plaid]);
  return <primitive object={object} visible={visibleGroups(room).salon} />;
}
