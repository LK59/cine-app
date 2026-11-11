import { DoubleSide, MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from "three";
import { applyScreenLight } from "./screenLight";

/**
 * Le vitrage : un miroir presque transparent — ce qu'on voit d'une vitre le soir, c'est la pièce qui
 * s'y reflète faiblement par-dessus la nuit — et, au bas de chaque carreau, **le givre** : des cristaux
 * qui montent depuis la traverse, plus haut dans les coins, avec un voile de buée au-dessus.
 *
 * Le givre est dessiné par le programme de la matière, à partir de la position du point dans le monde :
 * `base` est la hauteur de la traverse basse du vitrage (chaque famille de fenêtres a la sienne, donc sa
 * matière).
 */
const FROST_PARS = /* glsl */ `
  uniform float uFrostBase;
  uniform float uFrostHeight;
  float frostHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
  float frostNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( frostHash( i ), frostHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( frostHash( i + vec2( 0.0, 1.0 ) ), frostHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
  }
  float frostAmount( vec3 world ) {
    // Le long du mur : l'une des deux coordonnées horizontales est constante sur un vitrage.
    vec2 p = vec2( world.x + world.z, world.y );
    float h = ( world.y - uFrostBase ) / uFrostHeight;
    float rise = frostNoise( p * vec2( 1.3, 0.7 ) ) * 0.8 + frostNoise( p * vec2( 4.0, 2.0 ) ) * 0.35;
    // Les cristaux : un grain fin, sans direction — de près on dirait du sucre, de loin un voile.
    float crystals = frostNoise( p * 70.0 ) * 0.55 + frostNoise( p * 160.0 ) * 0.45;
    // Dense tout en bas, vite clairsemé : au-dessus d'une main, on voit de nouveau dehors.
    float body = smoothstep( 0.2 + rise * 0.5, 0.0, h );
    body *= body;
    return clamp( body * ( 0.4 + 0.75 * crystals ), 0.0, 1.0 ) * step( 0.0, h + 0.05 ) * 0.85;
  }
`;

function frostPatch(base: number, height: number) {
  return (shader: WebGLProgramParametersWithUniforms) => {
    applyScreenLight(shader);
    // Pas de reflet direct des lampes : sur un miroir aussi lisse, chaque lumière ponctuelle donnait un disque
    // éblouissant cerné de noir, posé sur la nuit — trois dans la fenêtre de la cuisine.
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\nreflectedLight.directSpecular = vec3( 0.0 );");
    shader.uniforms.uFrostBase = { value: base };
    shader.uniforms.uFrostHeight = { value: height };
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", `${FROST_PARS}\nvoid main() {`)
      .replace(
        "#include <metalnessmap_fragment>",
        /* glsl */ `#include <metalnessmap_fragment>
        {
          float frost = frostAmount( vSlWorld );
          // Bleuté : sous la lumière chaude de la pièce, il ressort blanc — et non roux.
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.5, 0.68, 0.98 ), frost );
          diffuseColor.a = mix( diffuseColor.a, 0.78, frost );
          roughnessFactor = mix( roughnessFactor, 0.9, frost );
          metalnessFactor = mix( metalnessFactor, 0.0, frost );
        }`
      );
  };
}

/** Un vitrage dont la traverse basse est à `base` mètres du sol ; le givre y monte sur `height` mètres au plus. */
export function glassMaterial(base: number, height = 0.55): MeshStandardMaterial {
  // Un reflet de la pièce discret : à 1,3 il couvrait la nuit dehors.
  const material = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.03, metalness: 1, transparent: true, opacity: 0.1, envMapIntensity: 0.55, depthWrite: false, side: DoubleSide });
  material.defines = { SL_MIRROR: "" };
  material.onBeforeCompile = frostPatch(base, height);
  material.customProgramCacheKey = () => "vitrage-givre-2";
  return material;
}
