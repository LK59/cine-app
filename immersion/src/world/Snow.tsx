import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferAttribute, BufferGeometry, ShaderMaterial, Vector3 } from "three";
import { useProfile } from "../state/store";
import { PLAN, ROOM } from "./layout";

/** Le volume où il neige : une boîte autour du chalet. */
const BOX = new Vector3(70, 22, 78);
const CENTER = new Vector3(0, 9.5, 2);

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixels;
  uniform vec3 uBox;
  uniform vec3 uCenter;
  attribute vec4 aSeed;
  varying float vFade;
  varying float vWarm;
  void main() {
    // Chaque flocon tombe à sa vitesse, poussé par un vent léger, et se balance ; la boîte se referme
    // sur elle-même, si bien qu'il neige sans fin sans rien recréer.
    float fall = 0.55 + aSeed.w * 0.75;
    vec3 p = position;
    p.y -= uTime * fall;
    p.x += uTime * 0.42 + sin(uTime * (0.5 + aSeed.x) + aSeed.y * 6.2832) * 0.28;
    p.z += uTime * 0.16 + cos(uTime * (0.4 + aSeed.y) + aSeed.x * 6.2832) * 0.22;
    p = mod(p + uBox * 0.5, uBox) - uBox * 0.5 + uCenter;
    // Il ne neige pas dans la maison : un flocon qui entre dans son volume n'est pas dessiné.
    bool main = abs(p.x) < ${(ROOM.halfW + 0.45).toFixed(2)} && p.z > ${(ROOM.north - 0.1).toFixed(2)} && p.z < ${(ROOM.back + 0.4).toFixed(2)} && p.y < ${(ROOM.ridge + 0.6).toFixed(2)} - abs(p.x) * 0.72;
    bool wing = p.x > ${(-ROOM.halfW - 0.4).toFixed(2)} && p.x < ${(PLAN.hall.x1 + 0.4).toFixed(2)} && p.z >= ${(ROOM.back + 0.4).toFixed(2)} && p.z < ${(PLAN.bedroom.z1 + 0.4).toFixed(2)} && p.y < 2.9;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    if (main || wing) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    float size = (0.022 + aSeed.z * 0.03);
    gl_PointSize = clamp(size * uPixels * projectionMatrix[1][1] / -mv.z, 0.0, 14.0);
    // Au loin, les flocons se fondent dans la nuit ; tout près des fenêtres, ils prennent leur lumière.
    vFade = smoothstep(46.0, 9.0, -mv.z) * (0.45 + 0.55 * aSeed.z);
    float toBay = length(vec2(max(abs(p.x) - 5.4, 0.0), ${ROOM.north.toFixed(1)} - p.z));
    vWarm = exp(-toBay * 0.55) * step(p.z, ${ROOM.north.toFixed(1)}) * smoothstep(9.5, 2.0, p.y);
  }
`;
const FRAGMENT = /* glsl */ `
  varying float vFade;
  varying float vWarm;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.2, d) * vFade;
    if (a < 0.01) discard;
    vec3 cold = vec3(0.62, 0.74, 1.0) * 0.4;
    vec3 warm = vec3(1.0, 0.74, 0.46) * 1.5;
    gl_FragColor = vec4(mix(cold, warm, vWarm), a);
  }
`;

/**
 * La neige qui tombe : un seul nuage de points, animé tout entier par la carte graphique. Le nombre
 * de flocons vient du préréglage de qualité. Elle ne tombe que dehors — on la voit derrière les
 * vitres, teintée par la lumière des fenêtres quand elle passe devant.
 */
export function Snow() {
  const count = useProfile().snow;
  const { geometry, material } = useMemo(() => {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    let seed = 11;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < count; i++) {
      positions.set([(random() - 0.5) * BOX.x, (random() - 0.5) * BOX.y, (random() - 0.5) * BOX.z], i * 3);
      seeds.set([random(), random(), random(), random()], i * 4);
    }
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new BufferAttribute(seeds, 4));
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uTime: { value: 0 }, uPixels: { value: 500 }, uBox: { value: BOX }, uCenter: { value: CENTER } },
      transparent: true,
      depthWrite: false,
    });
    return { geometry, material };
  }, [count]);

  useFrame(({ clock, size, viewport }) => {
    material.uniforms.uTime.value = clock.elapsedTime;
    material.uniforms.uPixels.value = (size.height * viewport.dpr) / 2;
  });

  return <points geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />;
}
