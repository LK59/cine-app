import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, Color, CylinderGeometry, DoubleSide, MeshStandardMaterial, PlaneGeometry, ShaderMaterial } from "three";
import { audio } from "../media/audio";
import { useStore } from "../state/store";
import { BREAST, FIRE } from "./layout";
import { visibleGroups } from "./Parts";
import { screenLight } from "./screenLight";

const WIDTH = FIRE.z1 - FIRE.z0 - 0.1;
const HEIGHT = FIRE.y1 - FIRE.y0 + 0.06;

const FLAME_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
/**
 * Les flammes : un bruit qui monte, étiré en langues, et taillé par la hauteur — large et dense à la
 * base, effiloché en haut. Les couleurs dépassent 1 exprès : c'est ce que le halo ramasse.
 */
const FLAME_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uLevel;
  uniform float uWidth;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; }
    return v;
  }
  void main() {
    // En mètres le long du foyer : les langues gardent leur taille quelle que soit sa longueur.
    float x = vUv.x * uWidth;
    float y = vUv.y;
    float t = uTime;
    // Des langues : chaque tranche du foyer a sa hauteur, qui change lentement.
    float tongue = 0.55 + 0.45 * noise(vec2(x * 3.2 + uSeed, t * 0.9)) + 0.25 * noise(vec2(x * 9.0 - uSeed, t * 2.3));
    // Le bruit monte, plus vite en haut ; il se tord un peu de côté.
    vec2 p = vec2(x * 4.5 + uSeed * 3.0 + 0.35 * sin(y * 5.0 + t * 2.0 + x * 2.0), y * 2.6 - t * 1.9);
    float n = fbm(p) * 0.65 + fbm(p * 2.3 + 3.0) * 0.35;
    float height = y / (tongue * uLevel + 0.001);
    float flame = smoothstep(1.0, 0.1, height + (0.5 - n) * 1.25);
    // Les bords du foyer : les flammes y sont plus basses.
    flame *= smoothstep(0.0, 0.035, vUv.x) * smoothstep(1.0, 0.965, vUv.x);
    if (flame < 0.004) discard;
    // Du cœur presque blanc à l'orange, puis au rouge sombre des pointes.
    vec3 color = mix(vec3(0.9, 0.12, 0.02), vec3(1.0, 0.5, 0.08), smoothstep(0.0, 0.5, flame));
    color = mix(color, vec3(1.0, 0.86, 0.5), smoothstep(0.55, 1.0, flame) * (1.0 - smoothstep(0.0, 0.55, height)));
    gl_FragColor = vec4(color * flame * 3.4, flame);
  }
`;

/** Le lit de braises : des taches qui rougeoient et respirent. */
const EMBER_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uLevel;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    vec2 p = vec2(vUv.x * 60.0, vUv.y * 5.0);
    float cells = noise(p) * 0.6 + noise(p * 2.7 + 4.0) * 0.4;
    float pulse = 0.65 + 0.35 * noise(vec2(vUv.x * 14.0, uTime * 0.7));
    float glow = smoothstep(0.42, 0.85, cells) * pulse * (0.35 + 0.65 * uLevel);
    vec3 color = mix(vec3(0.05, 0.012, 0.004), vec3(1.0, 0.33, 0.05), glow) * (0.25 + glow * 2.6);
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Le feu : des bûches sur un lit de braises, deux nappes de flammes l'une devant l'autre, une lueur
 * qui danse sur la pièce (par `screenLight`, qui sait éclairer les matières à lumière cuite), et le
 * crépitement, posé dans le foyer.
 *
 * Rien n'est simulé : deux rectangles et un bruit. Le coût est celui de leurs pixels — le foyer est
 * bas et long, il en couvre peu.
 */
export function Fire() {
  const room = useStore((s) => s.room);
  const lit = useStore((s) => s.fire);
  const graph = useMemo(() => audio(), []);

  const parts = useMemo(() => {
    const flame = (seed: number) =>
      new ShaderMaterial({
        vertexShader: FLAME_VERTEX,
        fragmentShader: FLAME_FRAGMENT,
        uniforms: { uTime: { value: 0 }, uSeed: { value: seed }, uLevel: { value: 1 }, uWidth: { value: WIDTH } },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
      });
    return {
      plane: new PlaneGeometry(WIDTH, HEIGHT).translate(0, HEIGHT / 2, 0),
      flames: [flame(1.7), flame(8.3)],
      embers: new ShaderMaterial({ vertexShader: FLAME_VERTEX, fragmentShader: EMBER_FRAGMENT, uniforms: { uTime: { value: 0 }, uLevel: { value: 1 } } }),
      bed: new PlaneGeometry(WIDTH, FIRE.depth - 0.06),
      log: new CylinderGeometry(0.045, 0.05, 1, 10),
      bark: new MeshStandardMaterial({ color: "#1a120c", roughness: 0.95, emissive: new Color("#ff4a0a"), emissiveIntensity: 0.22 }),
    };
  }, []);
  useEffect(
    () => () => {
      for (const m of [...parts.flames, parts.embers, parts.bark]) m.dispose();
      for (const g of [parts.plane, parts.bed, parts.log]) g.dispose();
      screenLight.uniforms.uSlFireColor.value.setRGB(0, 0, 0);
    },
    [parts]
  );

  const level = useMemo(() => ({ value: 1 }), []);
  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    // Le feu s'allume et s'éteint en quelques secondes ; éteint, il reste des braises.
    level.value += ((lit ? 1 : 0) - level.value) * (1 - Math.exp(-Math.min(delta, 0.1) * 0.9));
    for (const material of parts.flames) {
      material.uniforms.uTime.value = t;
      material.uniforms.uLevel.value = level.value;
    }
    parts.embers.uniforms.uTime.value = t;
    parts.embers.uniforms.uLevel.value = level.value;
    parts.bark.emissiveIntensity = 0.06 + 0.2 * level.value;
    // Sa lueur : chaude, qui danse — plus nerveuse que le souffle des bougies.
    const dance = 0.82 + 0.1 * Math.sin(t * 9.1) + 0.07 * Math.sin(t * 15.3 + 1.1) + 0.06 * Math.sin(t * 4.3 + 0.5) + 0.05 * Math.sin(t * 23.0);
    const strength = (0.12 + 0.88 * level.value) * dance * 15;
    screenLight.uniforms.uSlFire.value.set(...FIRE.glow);
    screenLight.uniforms.uSlFireColor.value.setRGB(1.0 * strength, 0.42 * strength, 0.12 * strength);
    graph.fire.setVolume(0.55 * (0.15 + 0.85 * level.value));
  });

  const x = BREAST.face + FIRE.depth;
  const z = (FIRE.z0 + FIRE.z1) / 2;
  const logs: [number, number, number, number][] = [
    [-1.25, 0.05, 0.92, 0.06],
    [-0.42, 0.09, 0.8, -0.05],
    [0.4, 0.04, 0.95, 0.04],
    [1.22, 0.1, 0.78, -0.07],
    [-0.85, 0.02, 0.7, 0.3],
    [0.85, 0.03, 0.72, -0.28],
  ];
  return (
    <group visible={visibleGroups(room).salon} name="fire">
      {/* Les braises, à plat au fond du foyer. */}
      <mesh geometry={parts.bed} material={parts.embers} position={[x - FIRE.depth / 2, FIRE.y0 + 0.016, z]} rotation={[-Math.PI / 2, 0, Math.PI / 2]} />
      {logs.map(([dz, tilt, length, yaw], i) => (
        <mesh key={i} geometry={parts.log} material={parts.bark} position={[x - FIRE.depth * (0.42 + (i % 2) * 0.16), FIRE.y0 + 0.06 + (i > 3 ? 0.07 : 0), z + dz]} rotation={[Math.PI / 2 + tilt, yaw, 0]} scale={[1, length, 1]} />
      ))}
      {/* Deux nappes de flammes, tournées vers la pièce. */}
      <mesh geometry={parts.plane} material={parts.flames[0]} position={[x - FIRE.depth * 0.38, FIRE.y0 + 0.02, z]} rotation-y={-Math.PI / 2} renderOrder={6} />
      <mesh geometry={parts.plane} material={parts.flames[1]} position={[x - FIRE.depth * 0.66, FIRE.y0 + 0.02, z]} rotation-y={-Math.PI / 2} scale={[1, 0.8, 1]} renderOrder={6} />
      <primitive object={graph.fire} position={[BREAST.face - 0.1, FIRE.y0 + 0.15, z]} />
    </group>
  );
}
