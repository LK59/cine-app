import { Color, Material, MeshStandardMaterial, Vector2, Vector3, type Texture, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from "three";
import { PLAN, ROOM, SCREENS, screenHeight } from "./layout";

/**
 * La lumière des écrans, écrite une fois pour toutes les matières du chalet.
 *
 * Deux choses, que three ne sait pas faire à ce prix :
 *
 * - **l'ambilight par zones** : chaque écran est découpé en six zones (trois colonnes, deux rangées),
 *   dont la couleur est relevée sur l'image du film. Chaque zone éclaire la pièce comme une petite
 *   surface lumineuse — le mur à gauche de l'écran prend la teinte du bord gauche de l'image, le
 *   plafond celle du haut. Une lumière rectangulaire de three (`RectAreaLight`) n'a qu'une couleur,
 *   coûte plus cher, et il en aurait fallu une par écran ;
 * - **le reflet du film** : pour chaque point d'une surface, le rayon réfléchi est prolongé jusqu'au
 *   plan de l'écran ; s'il le touche, c'est l'image elle-même qui s'y lit — nette dans une vitre,
 *   floue sur un parquet (une copie réduite de l'image sert de version floue). Ni second rendu de la
 *   scène, ni capture rafraîchie : une ou deux lectures de texture.
 *
 * Tous les écrans éclairent en même temps, chacun dans le volume de sa pièce (la lumière ne connaît
 * pas les murs : sans cette borne, l'écran de la chambre éclairerait le couloir).
 *
 * Le **feu** de l'âtre y ajoute sa lueur, qui danse : une lumière ponctuelle de plus, bornée au volume
 * ouvert du salon. Elle passe par ici parce que les matières à lumière cuite ignorent les lumières de
 * three (leur éclairage est dans leur lightmap), et que cette lueur-là bouge.
 *
 * Le programme est greffé sur **toutes** les matières « standard » (`installScreenLight`) : les
 * matières construites, les modèles, les vitres. Les uniformes sont partagés : une écriture par image.
 */
const N = SCREENS.length;
/** Colonnes et rangées de zones par écran. */
export const ZONES_X = 3;
export const ZONES_Y = 2;
const ZONES = ZONES_X * ZONES_Y;

/** Le volume ouvert : salon, cuisine, mezzanine. */
const OPEN_MIN = new Vector3(-ROOM.halfW - 0.4, -1, ROOM.north - 0.4);
const OPEN_MAX = new Vector3(ROOM.halfW + 0.4, ROOM.ridge + 1, ROOM.back + 0.05);

function volumeOf(room: string): [Vector3, Vector3] {
  if (room === "chambre") return [new Vector3(PLAN.bedroom.x0 - 0.4, -1, PLAN.bedroom.z0 - 0.02), new Vector3(PLAN.bedroom.x1 + 0.4, PLAN.bedroom.height + 0.4, PLAN.bedroom.z1 + 0.4)];
  return [OPEN_MIN, OPEN_MAX];
}

export const screenLight = {
  uniforms: {
    /** L'image du film (nette), et sa copie réduite (floue). */
    uSlVideo: { value: null as Texture | null },
    uSlBlur: { value: null as Texture | null },
    /** Le cadrage de l'image dans la dalle (bandes noires). */
    uSlFit: { value: new Vector2(1, 1) },
    /** Les écrans sont-ils allumés ? 0 à 1. */
    uSlOn: { value: 0 },
    uSlCenter: { value: SCREENS.map((s) => new Vector3(...s.center)) },
    /** L'axe horizontal de la dalle (vers la droite de l'image) et sa normale (vers la pièce). */
    uSlRight: { value: SCREENS.map((s) => new Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw))) },
    uSlNormal: { value: SCREENS.map((s) => new Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw))) },
    /** Demi-largeur, demi-hauteur. */
    uSlHalf: { value: SCREENS.map((s) => new Vector2(s.width / 2, screenHeight(s) / 2)) },
    uSlBoxMin: { value: SCREENS.map((s) => volumeOf(s.room)[0]) },
    uSlBoxMax: { value: SCREENS.map((s) => volumeOf(s.room)[1]) },
    /** La couleur de chaque zone de l'image, en linéaire : rangée du haut d'abord, de gauche à droite. */
    uSlZones: { value: Array.from({ length: ZONES }, () => new Color(0, 0, 0)) },
    /** Ce que vaut un blanc d'écran en lumière émise, et la force du reflet. */
    uSlGain: { value: 11 },
    uSlMirror: { value: 1.1 },
    /** Le feu : où il est, et sa couleur multipliée par sa force du moment. */
    uSlFire: { value: new Vector3(0, -100, 0) },
    uSlFireColor: { value: new Color(0, 0, 0) },
    uSlOpenMin: { value: OPEN_MIN },
    uSlOpenMax: { value: OPEN_MAX },
  },
};

const VERTEX_PARS = /* glsl */ `
  varying vec3 vSlWorld;
`;
const VERTEX_MAIN = /* glsl */ `
  {
    vec4 slPosition = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      slPosition = instanceMatrix * slPosition;
    #endif
    vSlWorld = ( modelMatrix * slPosition ).xyz;
  }
`;
const FRAGMENT_PARS = /* glsl */ `
  varying vec3 vSlWorld;
  uniform sampler2D uSlVideo;
  uniform sampler2D uSlBlur;
  uniform vec2 uSlFit;
  uniform float uSlOn;
  uniform vec3 uSlCenter[ ${N} ];
  uniform vec3 uSlRight[ ${N} ];
  uniform vec3 uSlNormal[ ${N} ];
  uniform vec2 uSlHalf[ ${N} ];
  uniform vec3 uSlBoxMin[ ${N} ];
  uniform vec3 uSlBoxMax[ ${N} ];
  uniform vec3 uSlZones[ ${ZONES} ];
  uniform float uSlGain;
  uniform float uSlMirror;
  uniform vec3 uSlFire;
  uniform vec3 uSlFireColor;
  uniform vec3 uSlOpenMin;
  uniform vec3 uSlOpenMax;
  float slInside( vec3 p, vec3 lo, vec3 hi ) {
    vec3 inside = step( lo, p ) * step( p, hi );
    return inside.x * inside.y * inside.z;
  }
`;
const FRAGMENT_MAIN = /* glsl */ `
  {
    vec3 slN = inverseTransformDirection( normal, viewMatrix );
    vec3 slV = normalize( cameraPosition - vSlWorld );
    vec3 slAlbedo = BRDF_Lambert( material.diffuseColor );

    // ── Le feu : une lueur ponctuelle, dans le volume ouvert ──────────────────
    float slFireMask = slInside( vSlWorld, uSlOpenMin, uSlOpenMax );
    if ( slFireMask > 0.0 ) {
      vec3 toFire = uSlFire - vSlWorld;
      float r2 = dot( toFire, toFire );
      // Un peu de lumière « enveloppante » : la flamme est large, pas un point.
      float facing = max( dot( slN, toFire * inversesqrt( r2 ) ) * 0.8 + 0.2, 0.0 );
      reflectedLight.directDiffuse += uSlFireColor * ( facing / ( r2 + 0.35 ) ) * slAlbedo;
    }

    // ── Les écrans ────────────────────────────────────────────────────────────
    if ( uSlOn > 0.001 ) {
      vec3 slR = reflect( - slV, slN );
      float slNoV = saturate( dot( slN, slV ) );
      for ( int s = 0; s < ${N}; s ++ ) {
        if ( slInside( vSlWorld, uSlBoxMin[ s ], uSlBoxMax[ s ] ) < 0.5 ) continue;
        vec3 c = uSlCenter[ s ];
        vec3 n = uSlNormal[ s ];
        vec3 right = uSlRight[ s ];
        vec2 halfSize = uSlHalf[ s ];
        // Derrière l'écran, rien.
        float front = dot( vSlWorld - c, n );
        if ( front < 0.0 ) continue;

        // L'ambilight : chaque zone, une petite surface qui éclaire (éclairement = luminance × aire ×
        // les deux cosinus / distance²).
        vec3 E = vec3( 0.0 );
        for ( int j = 0; j < ${ZONES}; j ++ ) {
          vec2 o = vec2( ( float( j - ( j / ${ZONES_X} ) * ${ZONES_X} ) + 0.5 ) / ${ZONES_X}.0, ( float( j / ${ZONES_X} ) + 0.5 ) / ${ZONES_Y}.0 ) * 2.0 - 1.0;
          vec3 p = c + right * ( o.x * halfSize.x ) - vec3( 0.0, o.y * halfSize.y, 0.0 );
          vec3 d = p - vSlWorld;
          float r2 = dot( d, d );
          vec3 l = d * inversesqrt( r2 );
          E += uSlZones[ j ] * ( max( dot( slN, l ), 0.0 ) * max( dot( n, - l ), 0.0 ) / ( r2 + 0.2 ) );
        }
        float zoneArea = 4.0 * halfSize.x * halfSize.y / ${ZONES}.0;
        reflectedLight.directDiffuse += E * ( zoneArea * uSlGain * uSlOn ) * slAlbedo;

        // Le halo : le mur qui porte l'écran est dans son plan — la dalle ne l'éclaire pas, en vrai
        // comme ici. C'est le halo d'un téléviseur à rétro-éclairage d'ambiance : autour de l'image, le
        // mur prend la couleur du bord le plus proche, et s'éteint en s'éloignant.
        if ( front < 0.6 ) {
          vec3 rel = vSlWorld - c;
          vec2 q0 = vec2( dot( rel, right ) / halfSize.x, rel.y / halfSize.y );
          vec2 beyond = max( abs( q0 ) - 1.0, 0.0 ) * halfSize;
          float away = length( beyond );
          if ( away > 0.0 ) {
            vec2 z2 = clamp( q0 * 0.5 + 0.5, 0.0, 0.999 );
            int zi = int( z2.x * ${ZONES_X}.0 ) + int( ( 1.0 - z2.y ) * ${ZONES_Y}.0 ) * ${ZONES_X};
            float halo = exp( - away * 1.7 ) * max( dot( slN, n ), 0.0 ) * ( 1.0 - front / 0.6 );
            reflectedLight.directDiffuse += uSlZones[ zi ] * ( halo * uSlGain * 0.5 * uSlOn ) * slAlbedo;
          }
        }

        // Le reflet : le rayon réfléchi rencontre-t-il la dalle ?
        float toward = dot( slR, n );
        if ( toward < -0.0001 ) {
          float t = - front / toward;
          vec3 hit = vSlWorld + slR * t - c;
          vec2 q = vec2( dot( hit, right ) / halfSize.x, hit.y / halfSize.y );
          // Plus la surface est rugueuse, plus le bord du reflet s'étale.
          float soft = 0.015 + material.roughness * 0.7;
          vec2 edge = smoothstep( vec2( 1.0 + soft ), vec2( 1.0 - soft * 0.6 ), abs( q ) );
          float cover = edge.x * edge.y;
          if ( cover > 0.001 ) {
            vec2 uv = ( clamp( q, -1.0, 1.0 ) * 0.5 ) * uSlFit + 0.5;
            vec2 inFrame = step( vec2( 0.0 ), uv ) * step( uv, vec2( 1.0 ) );
            // L'image nette est lue telle que le navigateur la donne (codée sRGB) : décodée ici.
            vec3 sharp = pow( texture2D( uSlVideo, uv ).rgb, vec3( 2.2 ) );
            vec3 blurred = texture2D( uSlBlur, uv ).rgb;
            vec3 image = mix( sharp, blurred, smoothstep( 0.04, 0.4, material.roughness ) ) * inFrame.x * inFrame.y;
            vec3 fresnel = F_Schlick( material.specularColor, material.specularF90, slNoV );
            float gloss = 1.0 - material.roughness;
            reflectedLight.directSpecular += image * fresnel * ( cover * gloss * gloss * uSlMirror * uSlGain * 0.12 * uSlOn );
          }
        }
      }
    }
  }
`;

/** Greffe la lumière des écrans sur le programme d'une matière « standard ». */
export function applyScreenLight(shader: WebGLProgramParametersWithUniforms): void {
  Object.assign(shader.uniforms, screenLight.uniforms);
  shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>\n${VERTEX_PARS}`).replace("#include <project_vertex>", `#include <project_vertex>\n${VERTEX_MAIN}`);
  shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`).replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${FRAGMENT_MAIN}`);
}

let installed = false;

/**
 * À appeler une fois, avant toute matière : toutes les matières « standard » sans programme à elles
 * reçoivent la lumière des écrans. Celles qui retouchent leur programme (`onBeforeCompile` à elles)
 * appellent `applyScreenLight` dans leur retouche.
 */
export function installScreenLight(): void {
  if (installed) return;
  installed = true;
  const patch = function (this: Material, shader: WebGLProgramParametersWithUniforms, _renderer: WebGLRenderer) {
    applyScreenLight(shader);
  };
  MeshStandardMaterial.prototype.onBeforeCompile = patch;
  // La clé de cache de three est le texte de la retouche : la même pour toutes, c'est voulu.
  MeshStandardMaterial.prototype.customProgramCacheKey = () => "lumiere-des-ecrans";
}
