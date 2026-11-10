import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferAttribute, BufferGeometry, CircleGeometry, NormalBlending, ShaderMaterial, Vector3 } from "three";
import { audio } from "../media/audio";
import { useStore } from "../state/store";
import { MOON, TUB } from "./layout";
import { visibleGroups } from "./Parts";

const WATER_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
/**
 * L'eau du bain : éclairée par-dessous (une lumière turquoise au fond de la cuve), ridée par les
 * bulles, avec la lune qui s'y brise. Au-dessus de 1 par endroits : le halo en fait une lueur.
 */
const WATER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uMoonDir;
  varying vec2 vUv;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float surface(vec2 p) {
    return noise(p * 5.0 + uTime * vec2(0.35, 0.22)) * 0.6 + noise(p * 13.0 - uTime * vec2(0.5, 0.31)) * 0.4;
  }
  void main() {
    vec2 p = vWorld.xz;
    float r = length(vUv - 0.5) * 2.0;
    // Les rides : la pente de la surface, par différences.
    float e = 0.02;
    float h0 = surface(p);
    vec3 n = normalize(vec3((h0 - surface(p + vec2(e, 0.0))) * 1.6, 1.0, (h0 - surface(p + vec2(0.0, e))) * 1.6));
    vec3 view = normalize(cameraPosition - vWorld);
    // Le fond éclairé : plus clair au centre, et des filets de lumière qui ondulent.
    float caustics = pow(noise(p * 7.0 + n.xz * 2.0 + uTime * 0.25), 2.0);
    vec3 deep = mix(vec3(0.02, 0.2, 0.26), vec3(0.1, 0.72, 0.78), smoothstep(1.0, 0.0, r));
    vec3 color = deep * (0.55 + 0.9 * caustics) * 1.25;
    // La lune dans l'eau, brisée par les rides ; et le ciel, en rasant.
    float glint = pow(max(dot(reflect(-uMoonDir, n), view), 0.0), 90.0);
    float fresnel = pow(1.0 - max(dot(n, view), 0.0), 4.0);
    color += vec3(0.75, 0.86, 1.0) * glint * 2.4 + vec3(0.05, 0.09, 0.2) * fresnel;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const STEAM = 46;
const STEAM_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixels;
  attribute vec4 aSeed;
  varying float vFade;
  void main() {
    // Chaque bouffée monte, s'élargit, dérive avec le vent, puis recommence.
    float life = fract(uTime * (0.07 + aSeed.w * 0.05) + aSeed.z);
    vec3 p = position;
    p.y += life * (1.7 + aSeed.x * 0.9);
    p.x += life * life * 0.9 + sin(uTime * 0.6 + aSeed.y * 6.28) * 0.12 * life;
    p.z += life * 0.25 * (aSeed.y - 0.5);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp((0.34 + life * 0.95) * uPixels * projectionMatrix[1][1] / -mv.z, 0.0, 520.0);
    vFade = smoothstep(0.0, 0.12, life) * smoothstep(1.0, 0.35, life);
  }
`;
const STEAM_FRAGMENT = /* glsl */ `
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    a = a * a * vFade * 0.085;
    if (a < 0.002) discard;
    // La vapeur prend la lueur de l'eau en bas, le bleu de la nuit en haut : un gris bleuté suffit.
    gl_FragColor = vec4(vec3(0.62, 0.74, 0.84), a);
  }
`;

/**
 * Le bain nordique, vivant : son eau, sa vapeur, son bouillonnement. La cuve elle-même est de la
 * géométrie fixe (`geometry/terrace.ts`).
 */
export function HotTub() {
  const room = useStore((s) => s.room);
  const graph = useMemo(() => audio(), []);
  const parts = useMemo(() => {
    const steam = new BufferGeometry();
    const positions = new Float32Array(STEAM * 3);
    const seeds = new Float32Array(STEAM * 4);
    let seed = 3;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < STEAM; i++) {
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * (TUB.radius - 0.2);
      positions.set([TUB.x + Math.cos(a) * r, TUB.water + 0.05, TUB.z + Math.sin(a) * r], i * 3);
      seeds.set([random(), random(), random(), random()], i * 4);
    }
    steam.setAttribute("position", new BufferAttribute(positions, 3));
    steam.setAttribute("aSeed", new BufferAttribute(seeds, 4));
    return {
      water: new CircleGeometry(TUB.radius - 0.07, 48).rotateX(-Math.PI / 2),
      waterMaterial: new ShaderMaterial({ vertexShader: WATER_VERTEX, fragmentShader: WATER_FRAGMENT, uniforms: { uTime: { value: 0 }, uMoonDir: { value: new Vector3(...MOON.lightFrom).normalize() } } }),
      steam,
      steamMaterial: new ShaderMaterial({ vertexShader: STEAM_VERTEX, fragmentShader: STEAM_FRAGMENT, uniforms: { uTime: { value: 0 }, uPixels: { value: 500 } }, transparent: true, depthWrite: false, blending: NormalBlending }),
    };
  }, []);
  useEffect(
    () => () => {
      parts.water.dispose();
      parts.waterMaterial.dispose();
      parts.steam.dispose();
      parts.steamMaterial.dispose();
    },
    [parts]
  );
  useFrame(({ clock, size, viewport }) => {
    parts.waterMaterial.uniforms.uTime.value = clock.elapsedTime;
    parts.steamMaterial.uniforms.uTime.value = clock.elapsedTime;
    parts.steamMaterial.uniforms.uPixels.value = (size.height * viewport.dpr) / 2;
  });
  return (
    <group visible={visibleGroups(room).terrasse} name="hot-tub">
      <mesh geometry={parts.water} material={parts.waterMaterial} position={[TUB.x, TUB.water, TUB.z]} />
      <points geometry={parts.steam} material={parts.steamMaterial} frustumCulled={false} renderOrder={4} />
      <primitive object={graph.tub} position={[TUB.x, TUB.water, TUB.z]} />
    </group>
  );
}
