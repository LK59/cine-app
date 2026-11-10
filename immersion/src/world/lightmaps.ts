import { useEffect, useState } from "react";
import { useThree } from "@react-three/fiber";
import { BufferAttribute, LinearFilter, LinearMipmapLinearFilter, ShaderChunk, SRGBColorSpace, type BufferGeometry, type CompressedTexture, type Material, type MeshStandardMaterial } from "three";
import { assetUrl } from "../lib/assets";
import { useStore } from "../state/store";
import { ktx2For } from "./ktx2";

/**
 * La lumière précalculée (`public/assets/lightmaps/`, cuite dans Blender par `tools/bake/`).
 *
 * Pour chaque groupe de pièces : une texture — l'éclairement reçu par chaque surface, toutes lampes,
 * lune et rebonds compris — et un second jeu d'UV, donné sommet par sommet dans l'ordre exact où la
 * page construit ses maillages. C'est ce qui permet de garder la géométrie écrite en code : seule la
 * lumière vient de Blender.
 *
 * Avec elle, les lumières temps réel se réduisent à ce qui bouge (`Lights`), et l'occlusion ambiante
 * en espace écran n'a plus de raison d'être.
 */
interface Manifest {
  /** Ce que vaut 1,0 dans la texture, en éclairement. */
  range: number;
  atlases: Record<string, { texture: string; size: number; uv?: string; uvSet?: string; meshes?: { name: string; material: string; offset: number; count: number; probe: number[][] }[] }>;
}

export interface Lightmaps {
  range: number;
  /** Par groupe : la texture, et pour chaque maillage (`<groupe>__<matière>`) ses UV de lumière. */
  atlases: Record<string, { texture: CompressedTexture; uvs: Map<string, { uv: Float32Array; probe: number[][] }> }>;
}

async function load(gl: Parameters<typeof ktx2For>[0]): Promise<Lightmaps | null> {
  const response = await fetch(assetUrl("lightmaps/lightmaps.json"), { credentials: "same-origin" });
  if (!response.ok) return null;
  const manifest = (await response.json()) as Manifest;
  if (!BAKED_SHADER_OK) return null;
  const loader = ktx2For(gl);
  const atlases: Lightmaps["atlases"] = {};
  await Promise.all(
    Object.entries(manifest.atlases).map(async ([group, atlas]) => {
      const [texture, packed] = await Promise.all([
        loader.loadAsync(assetUrl(`lightmaps/${atlas.texture}`)),
        atlas.uv ? fetch(assetUrl(`lightmaps/${atlas.uv}`), { credentials: "same-origin" }).then((r) => (r.ok ? r.arrayBuffer() : null)) : Promise.resolve(null),
      ]);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      // Le second jeu d'UV du maillage.
      texture.channel = 1;
      texture.needsUpdate = true;
      const uvs = new Map<string, { uv: Float32Array; probe: number[][] }>();
      if (packed && atlas.meshes) {
        const all = new Uint16Array(packed);
        for (const mesh of atlas.meshes) {
          const uv = new Float32Array(mesh.count * 2);
          for (let i = 0; i < uv.length; i++) uv[i] = all[mesh.offset * 2 + i] / 65535;
          uvs.set(mesh.name, { uv, probe: mesh.probe });
        }
      }
      atlases[group] = { texture, uvs };
    })
  );
  return { range: manifest.range, atlases };
}

/** Charge la lumière précalculée si elle est là. Sans elle, le chalet est éclairé en temps réel, comme avant. */
export function useLightmaps(): Lightmaps | null {
  const gl = useThree((s) => s.gl);
  const [lightmaps, setLightmaps] = useState<Lightmaps | null>(null);
  useEffect(() => {
    let alive = true;
    load(gl).then(
      (loaded) => alive && loaded && setLightmaps(loaded),
      () => {
        // Lumière cuite absente ou illisible : l'éclairage temps réel reste en place.
      }
    );
    return () => {
      alive = false;
    };
  }, [gl]);
  const setBaked = useStore((s) => s.setBaked);
  useEffect(() => {
    setBaked(lightmaps !== null);
    return () => setBaked(false);
  }, [lightmaps, setBaked]);
  return lightmaps;
}

/**
 * Pose les UV de lumière sur un maillage construit par la page — si c'est bien le même maillage que
 * celui qui a été cuit : même nombre de sommets, mêmes sommets témoins au millimètre. Sinon rien n'est
 * posé (la géométrie a changé depuis la cuisson : ce maillage reste éclairé en temps réel).
 */
export function attachLightmapUv(geometry: BufferGeometry, baked: { uv: Float32Array; probe: number[][] } | undefined): boolean {
  if (!baked) return false;
  const position = geometry.getAttribute("position");
  if (position.count * 2 !== baked.uv.length) return false;
  const indices = [0, Math.floor(position.count / 2), position.count - 1];
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const expected = baked.probe[k];
    if (!expected || Math.abs(position.getX(i) - expected[0]) > 0.002 || Math.abs(position.getY(i) - expected[1]) > 0.002 || Math.abs(position.getZ(i) - expected[2]) > 0.002) return false;
  }
  geometry.setAttribute("uv1", new BufferAttribute(baked.uv, 2));
  return true;
}

const variants = new WeakMap<Material, Map<CompressedTexture, Material>>();
/** Toutes les matières éclairées par une lightmap, et ce que vaut 1,0 dans la leur. */
const baked = new Set<MeshStandardMaterial>();
let range = 1;

/**
 * Le souffle des bougies sur la lumière cuite : toute la lumière des pièces monte et descend de
 * quelques pour cent, ensemble. C'est faux dans le détail (la lune ne respire pas), invisible en
 * pratique — et ça ne coûte qu'un nombre par matière.
 */
export function breathe(gain: number): void {
  for (const material of baked) material.lightMapIntensity = range * gain;
}

// Le programme d'une matière cuite, en deux retouches de celui de three :
// - sa lumière diffuse vient de la lightmap **seule** : ni le ciel, ni l'environnement, ni les lampes
//   temps réel n'y ajoutent rien (la lightmap les contient déjà, rebonds compris — les additionner
//   éclaircirait tout). Les lampes gardent leurs reflets, l'environnement aussi ;
// - sauf la lumière de l'écran (une lumière de surface, traitée après les autres), qui change à
//   chaque image et ne peut pas être cuite : elle éclaire pleinement.
const RECT_AREA = "#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )";
const BEGIN = ShaderChunk.lights_fragment_begin.replace(RECT_AREA, `reflectedLight.directDiffuse = vec3( 0.0 );\n${RECT_AREA}`);
const MAPS = ShaderChunk.lights_fragment_maps.replace("irradiance += lightMapIrradiance;", "irradiance = lightMapIrradiance;").replace("iblIrradiance += getIBLIrradiance( geometryNormal );", "");
/** Faux si three a changé ces morceaux de programme : mieux vaut alors l'éclairage temps réel qu'une lumière comptée deux fois. */
export const BAKED_SHADER_OK = BEGIN !== ShaderChunk.lights_fragment_begin && MAPS.includes("irradiance = lightMapIrradiance;") && !MAPS.includes("iblIrradiance +=");

/** La même matière, éclairée par une lightmap (voir ci-dessus ce que cela change à son programme). */
export function bakedVariant(material: Material, lightMap: CompressedTexture, lightMapRange: number): Material {
  let byMap = variants.get(material);
  if (!byMap) variants.set(material, (byMap = new Map()));
  const existing = byMap.get(lightMap);
  if (existing) return existing;
  const variant = material.clone() as MeshStandardMaterial;
  variant.lightMap = lightMap;
  variant.lightMapIntensity = lightMapRange;
  range = lightMapRange;
  baked.add(variant);
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  variant.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_begin>", BEGIN).replace("#include <lights_fragment_maps>", MAPS);
  };
  variant.customProgramCacheKey = () => `${key}|cuit`;
  byMap.set(lightMap, variant);
  return variant;
}
