import { useMemo } from "react";
import { useLoader, useThree } from "@react-three/fiber";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { Color, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, NoColorSpace, Vector2, type Texture, type WebGLRenderer } from "three";
import { assetUrl, BASIS_PATH } from "../lib/assets";
import { useProfile } from "../state/store";

/**
 * Les matières du chalet : des jeux de textures PBR (couleur, normales, et une carte « ARM » —
 * occlusion, rugosité, métal dans ses trois canaux), tous en KTX2.
 *
 * KTX2 reste compressé dans la mémoire de la carte graphique : un jeu 2K y pèse quelques
 * mégaoctets au lieu de plusieurs dizaines, ce qui compte sur un processeur graphique intégré.
 */
export type TextureSet =
  | "wood_floor"
  | "wood_beam"
  | "wood_planks_ceiling"
  | "stone_wall"
  | "stone_slab"
  | "fabric_sofa"
  | "fabric_pillow"
  | "rug"
  | "plaster"
  | "snow"
  | "leather"
  | "counter_stone"
  | "linen_white"
  | "bark";

/** Le chargeur KTX2 doit savoir ce que cette carte graphique sait décompresser. */
export function configureKtx2(gl: WebGLRenderer) {
  return (loader: KTX2Loader) => {
    loader.setTranscoderPath(BASIS_PATH);
    loader.detectSupport(gl);
  };
}

export interface PbrOptions {
  /** Teinte multipliée à la couleur de la texture. */
  tint?: string;
  /** Multiplie la rugosité lue dans la carte (1 = telle quelle). */
  roughness?: number;
  /** Force du relief. */
  bump?: number;
  /** Poids de l'environnement (reflets). */
  env?: number;
  /** La carte ARM porte-t-elle un vrai canal métal ? Faux pour le bois, la pierre, le tissu. */
  metal?: boolean;
  /**
   * Saturation de la couleur de la texture (1 = telle quelle). Une teinte ne fait que multiplier :
   * elle assombrit un bois trop rouge sans le rendre moins rouge. Ceci, si.
   */
  saturation?: number;
}

function prepare(texture: Texture, anisotropy: number, srgb: boolean): Texture {
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * La matière d'un jeu de textures. Les UV sont en mètres divisés par la taille d'un carreau
 * (`Kit`, `projectUVs`) : rien à répéter ici.
 */
export function usePbr(set: TextureSet, options: PbrOptions = {}): MeshStandardMaterial {
  const gl = useThree((s) => s.gl);
  const anisotropy = useProfile().anisotropy;
  const [color, normal, arm] = useLoader(KTX2Loader, [assetUrl(`textures/${set}/color.ktx2`), assetUrl(`textures/${set}/normal.ktx2`), assetUrl(`textures/${set}/arm.ktx2`)], configureKtx2(gl));
  const { tint, roughness = 1, bump = 1, env = 1, metal = false, saturation = 1 } = options;

  return useMemo(() => {
    const cap = Math.min(anisotropy, gl.capabilities.getMaxAnisotropy());
    prepare(color, cap, true);
    prepare(normal, cap, false);
    prepare(arm, cap, false);
    const material = new MeshStandardMaterial({
      map: color,
      normalMap: normal,
      normalScale: new Vector2(bump, bump),
      aoMap: arm,
      roughnessMap: arm,
      roughness,
      metalnessMap: metal ? arm : null,
      metalness: metal ? 1 : 0,
      envMapIntensity: env,
    });
    if (tint) material.color = new Color(tint);
    if (saturation !== 1) {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uSaturation = { value: saturation };
        shader.fragmentShader = shader.fragmentShader
          .replace("void main() {", "uniform float uSaturation;\nvoid main() {")
          .replace("#include <map_fragment>", "#include <map_fragment>\n\tdiffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), diffuseColor.rgb, uSaturation);");
      };
      // Le programme diffère de celui d'une matière ordinaire : three doit le savoir pour ne pas les confondre.
      material.customProgramCacheKey = () => "saturation";
    }
    return material;
  }, [color, normal, arm, anisotropy, gl, tint, roughness, bump, env, metal, saturation]);
}
