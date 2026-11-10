import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, ShaderMaterial, Vector3 } from "three";
import { useProfile, useStore } from "../state/store";
import { TV } from "./layout";
import { visibleGroups } from "./Parts";
import { screenLight } from "./screenLight";

/** Le volume devant le grand écran où la poussière se voit : sa largeur, sa hauteur, sa profondeur. */
const BOX = new Vector3(4.2, TV.width * 0.95, 3.2);

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixels;
  uniform vec3 uBox;
  uniform vec3 uOrigin;
  attribute vec4 aSeed;
  varying float vFade;
  void main() {
    // Une dérive très lente, qui boucle dans la boîte : l'air d'une pièce chauffée.
    vec3 p = position;
    p.y += uTime * (0.012 + aSeed.x * 0.02) + sin(uTime * 0.31 + aSeed.y * 6.28) * 0.05;
    p.x += sin(uTime * 0.23 + aSeed.z * 6.28) * 0.08;
    p.z += cos(uTime * 0.19 + aSeed.w * 6.28) * 0.08;
    p = mod(p, uBox) + uOrigin;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp((0.006 + aSeed.w * 0.007) * uPixels * projectionMatrix[1][1] / -mv.z, 0.0, 6.0);
    // Plus près de l'écran, plus de lumière ; tout contre l'œil, rien (un grain flou serait une tache).
    float toScreen = (uOrigin.x + uBox.x - p.x) / uBox.x;
    vFade = smoothstep(1.0, 0.1, toScreen) * smoothstep(0.35, 1.4, -mv.z) * (0.4 + 0.6 * aSeed.y);
  }
`;
const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d) * vFade;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

/**
 * La poussière dans la lumière de l'écran : des grains en suspension devant la grande dalle, qu'on ne
 * voit que quand un film joue — ils prennent la couleur de l'image. Un nuage de points, animé par la
 * carte graphique ; absent au préréglage le plus bas.
 */
export function Dust() {
  const room = useStore((s) => s.room);
  const count = useProfile().bloom ? 520 : 0;
  const parts = useMemo(() => {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    let seed = 41;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < count; i++) {
      positions.set([random() * BOX.x, random() * BOX.y, random() * BOX.z], i * 3);
      seeds.set([random(), random(), random(), random()], i * 4);
    }
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("aSeed", new BufferAttribute(seeds, 4));
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uTime: { value: 0 }, uPixels: { value: 500 }, uBox: { value: BOX }, uOrigin: { value: new Vector3(TV.x - BOX.x - 0.05, 0.9, TV.z - BOX.z / 2) }, uColor: { value: new Color(0, 0, 0) } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    return { geometry, material };
  }, [count]);
  useEffect(
    () => () => {
      parts.geometry.dispose();
      parts.material.dispose();
    },
    [parts]
  );
  const average = useMemo(() => new Color(), []);
  useFrame(({ clock, size, viewport }) => {
    parts.material.uniforms.uTime.value = clock.elapsedTime;
    parts.material.uniforms.uPixels.value = (size.height * viewport.dpr) / 2;
    // La couleur moyenne de l'image, telle que l'ambilight la connaît déjà.
    average.setRGB(0, 0, 0);
    const zones = screenLight.uniforms.uSlZones.value;
    for (const zone of zones) average.add(zone);
    parts.material.uniforms.uColor.value.copy(average).multiplyScalar((1.6 / zones.length) * screenLight.uniforms.uSlOn.value);
  });
  if (!count) return null;
  return <points geometry={parts.geometry} material={parts.material} frustumCulled={false} renderOrder={5} visible={visibleGroups(room).salon} />;
}
