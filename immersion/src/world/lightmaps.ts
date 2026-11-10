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
  atlases: Record<
    string,
    {
      texture: string;
      size: number;
      uv?: string;
      uvSet?: string;
      meshes?: { name: string; material: string; offset: number; count: number; probe: number[][] }[];
      /** Deux cuissons sur les mêmes UV : ce qui reste la nuit (lune, ciel, bougies), et les lampes. */
      layers?: { nuit: { texture: string; range: number }; lampes: { texture: string; range: number } };
    }
  >;
}

export interface Atlas {
  /** La lumière de base : tout, ou — quand la cuisson est en deux couches — ce qui reste la nuit. */
  texture: CompressedTexture;
  /** Ce que vaut 1,0 dans cette texture, en éclairement. */
  range: number;
  /** La couche des lampes, quand elle existe : c'est elle que le mode cinéma et les interrupteurs baissent. */
  lamps: { texture: CompressedTexture; range: number } | null;
  /** Pour chaque maillage (`<groupe>__<matière>`), ses UV de lumière. */
  uvs: Map<string, { uv: Float32Array; probe: number[][] }>;
}

export interface Lightmaps {
  /** Par groupe de pièces (`salon`, `sud`, `nuit`) et pour le canapé (`sofa`). */
  atlases: Record<string, Atlas>;
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
      const ready = (texture: CompressedTexture) => {
        texture.colorSpace = SRGBColorSpace;
        texture.minFilter = LinearMipmapLinearFilter;
        texture.magFilter = LinearFilter;
        // Le second jeu d'UV du maillage.
        texture.channel = 1;
        texture.needsUpdate = true;
        return texture;
      };
      const base = atlas.layers?.nuit ?? { texture: atlas.texture, range: manifest.range };
      const [texture, lamps, packed] = await Promise.all([
        loader.loadAsync(assetUrl(`lightmaps/${base.texture}`)).then(ready),
        atlas.layers ? loader.loadAsync(assetUrl(`lightmaps/${atlas.layers.lampes.texture}`)).then(ready) : Promise.resolve(null),
        atlas.uv ? fetch(assetUrl(`lightmaps/${atlas.uv}`), { credentials: "same-origin" }).then((r) => (r.ok ? r.arrayBuffer() : null)) : Promise.resolve(null),
      ]);
      const uvs = new Map<string, { uv: Float32Array; probe: number[][] }>();
      if (packed && atlas.meshes) {
        const all = new Uint16Array(packed);
        for (const mesh of atlas.meshes) {
          const uv = new Float32Array(mesh.count * 2);
          for (let i = 0; i < uv.length; i++) uv[i] = all[mesh.offset * 2 + i] / 65535;
          uvs.set(mesh.name, { uv, probe: mesh.probe });
        }
      }
      atlases[group] = { texture, range: base.range, lamps: lamps && atlas.layers ? { texture: lamps, range: atlas.layers.lampes.range } : null, uvs };
    })
  );
  return { atlases };
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

/**
 * Le niveau des lampes de chaque groupe de pièces, de 0 (éteintes) à 1 : écrit par `Lights` (le mode
 * cinéma, les interrupteurs), lu ici par les matières cuites. Le canapé suit le salon.
 */
export type LampGroup = "salon" | "sud" | "nuit";
const LAMP_GROUP: Record<string, LampGroup> = { salon: "salon", sofa: "salon", sud: "sud", nuit: "nuit" };
const lampLevel: Record<LampGroup, number> = { salon: 1, sud: 1, nuit: 1 };

interface Baked {
  material: MeshStandardMaterial;
  group: LampGroup;
  range: number;
  /** Le gain de la couche des lampes (sa portée × le niveau du groupe × le souffle) : un uniforme. */
  lamps: { value: number } | null;
  lampRange: number;
}
const baked = new Set<Baked>();
const variants = new WeakMap<Material, Map<Atlas, Material>>();
let breath = 1;

function refresh(entry: Baked): void {
  const level = lampLevel[entry.group];
  if (entry.lamps) {
    entry.material.lightMapIntensity = entry.range * breath;
    entry.lamps.value = entry.lampRange * level * breath;
  } else {
    // Une cuisson d'une seule couche : tout baisse ensemble, sans jamais faire nuit noire.
    entry.material.lightMapIntensity = entry.range * breath * (0.25 + 0.75 * level);
  }
}

/**
 * Le souffle des bougies sur la lumière cuite : toute la lumière des pièces monte et descend de
 * quelques pour cent, ensemble. C'est faux dans le détail (la lune ne respire pas), invisible en
 * pratique — et ça ne coûte qu'un nombre par matière.
 */
export function breathe(gain: number): void {
  breath = gain;
  for (const entry of baked) refresh(entry);
}

/** Le niveau des lampes d'un groupe (0 à 1). Appliqué au prochain `breathe`. */
export function setLampLevel(group: LampGroup, level: number): void {
  lampLevel[group] = level;
}

// Le programme d'une matière cuite, en deux retouches de celui de three :
// - sa lumière diffuse vient de la lightmap **seule** — ses deux couches, la nuit et les lampes : ni le
//   ciel, ni l'environnement, ni les lumières temps réel n'y ajoutent rien (la lightmap les contient
//   déjà, rebonds compris — les additionner éclaircirait tout). Les lampes gardent leurs reflets,
//   l'environnement aussi ;
// - ce qui bouge — la lumière des écrans, la lueur du feu — vient de `screenLight.ts`, qui s'ajoute
//   après (la remise à zéro ci-dessous est placée avant lui).
const RECT_AREA = "#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )";
const BEGIN = ShaderChunk.lights_fragment_begin.replace(RECT_AREA, `reflectedLight.directDiffuse = vec3( 0.0 );\n${RECT_AREA}`);
const MAPS_ONE = ShaderChunk.lights_fragment_maps.replace("irradiance += lightMapIrradiance;", "irradiance = lightMapIrradiance;").replace("iblIrradiance += getIBLIrradiance( geometryNormal );", "");
const MAPS_TWO = MAPS_ONE.replace("irradiance = lightMapIrradiance;", "irradiance = lightMapIrradiance + texture2D( uLampMap, vLightMapUv ).rgb * uLampGain;");
/** Faux si three a changé ces morceaux de programme : mieux vaut alors l'éclairage temps réel qu'une lumière comptée deux fois. */
export const BAKED_SHADER_OK = BEGIN !== ShaderChunk.lights_fragment_begin && MAPS_ONE.includes("irradiance = lightMapIrradiance;") && !MAPS_ONE.includes("iblIrradiance +=") && MAPS_TWO !== MAPS_ONE;

/** La même matière, éclairée par la lightmap de ce groupe (voir ci-dessus ce que cela change à son programme). */
export function bakedVariant(material: Material, group: string, atlas: Atlas): Material {
  let byAtlas = variants.get(material);
  if (!byAtlas) variants.set(material, (byAtlas = new Map()));
  const existing = byAtlas.get(atlas);
  if (existing) return existing;
  const variant = material.clone() as MeshStandardMaterial;
  variant.lightMap = atlas.texture;
  const lamps = atlas.lamps ? { value: atlas.lamps.range } : null;
  const entry: Baked = { material: variant, group: LAMP_GROUP[group] ?? "salon", range: atlas.range, lamps, lampRange: atlas.lamps?.range ?? 0 };
  baked.add(entry);
  refresh(entry);
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  variant.onBeforeCompile = (shader, renderer) => {
    before.call(material, shader, renderer);
    if (lamps && atlas.lamps) {
      shader.uniforms.uLampMap = { value: atlas.lamps.texture };
      shader.uniforms.uLampGain = lamps;
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\nuniform sampler2D uLampMap;\nuniform float uLampGain;`);
    }
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_begin>", BEGIN).replace("#include <lights_fragment_maps>", lamps ? MAPS_TWO : MAPS_ONE);
  };
  variant.customProgramCacheKey = () => `${key}|cuit${lamps ? "2" : "1"}`;
  byAtlas.set(atlas, variant);
  return variant;
}
