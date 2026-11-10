import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { lampLevels } from "./lampLevels";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, CylinderGeometry, InstancedMesh, MeshStandardMaterial, Object3D, ShaderMaterial } from "three";
import { CANDLES } from "./candles";

const FLAME_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aPhase;
  varying float vFlicker;
  uniform float uChandelier;
  attribute float aChandelier;
  varying float vLevel;
  void main() {
    // Chaque flamme a son propre souffle : deux sinus désaccordés, décalés par bougie.
    float f = 0.86 + 0.09 * sin(uTime * 9.0 + aPhase * 17.0) + 0.05 * sin(uTime * 23.0 + aPhase * 5.0);
    vFlicker = f;
    vec3 p = position;
    p.x += 0.004 * sin(uTime * 6.0 + aPhase * 11.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    // Taille en pixels d'une flamme de ~9 cm de haut, quelle que soit la distance.
    // Les bougies du lustre baissent avec les lampes du salon (mode cinéma, interrupteur) : une flamme plus courte.
    vLevel = mix(1.0, 0.3 + 0.7 * uChandelier, aChandelier);
    gl_PointSize = clamp(0.115 * f * vLevel * uPixelRatio * projectionMatrix[1][1] / -mv.z, 1.5, 220.0);
  }
`;

const FLAME_FRAGMENT = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uEdge;
  uniform float uGain;
  varying float vFlicker;
  varying float vLevel;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    uv.y = -uv.y;
    // Une goutte : étroite en haut, ronde en bas.
    float width = mix(0.42, 0.16, smoothstep(-0.7, 0.9, uv.y));
    float d = length(vec2(uv.x / width, (uv.y + 0.1) / 0.9));
    float body = smoothstep(1.0, 0.25, d);
    float core = smoothstep(0.7, 0.0, length(vec2(uv.x / 0.14, (uv.y + 0.32) / 0.42)));
    vec3 color = mix(uEdge, uCore, core) * (body + core * 0.6) * uGain * vFlicker * vLevel * vLevel;
    if (body < 0.01) discard;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const dummy = new Object3D();

/**
 * Les bougies : la cire (un maillage instancié) et les flammes (un nuage de points).
 *
 * Les flammes sont des points et non des lumières : la lumière des bougies du lustre est portée par
 * quelques lumières ponctuelles (`Lights`), sans quoi chaque matière paierait trente lumières par
 * pixel. Leur couleur dépasse 1 exprès — c'est ce que le halo (bloom) ramasse.
 */
export function Candles() {
  const wax = useRef<InstancedMesh>(null);
  const waxGeometry = useMemo(() => new CylinderGeometry(1, 1, 1, 10, 1).translate(0, 0.5, 0), []);
  // La cire laisse passer un peu de sa propre lumière : une émission chaude, faible.
  const waxMaterial = useMemo(() => new MeshStandardMaterial({ color: "#d8c9b0", roughness: 0.6, emissive: new Color("#ff8f3a"), emissiveIntensity: 0.07 }), []);

  const flames = useMemo(() => {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(CANDLES.length * 3);
    const phases = new Float32Array(CANDLES.length);
    CANDLES.forEach((c, i) => {
      positions.set([c.p[0], c.p[1] + c.h + 0.05, c.p[2]], i * 3);
      phases[i] = (i * 0.618034) % 1;
    });
    // Les vingt-six premières bougies sont celles du lustre (`candles.ts`).
    geometry.setAttribute("aChandelier", new BufferAttribute(Float32Array.from(CANDLES, (_, i) => (i < 26 ? 1 : 0)), 1));
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("aPhase", new BufferAttribute(phases, 1));
    const material = new ShaderMaterial({
      vertexShader: FLAME_VERTEX,
      fragmentShader: FLAME_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: 1 },
        uCore: { value: new Color("#fff3c4") },
        uEdge: { value: new Color("#ff8a2a") },
        uGain: { value: 4.2 },
        uChandelier: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    return { geometry, material };
  }, []);

  useLayoutEffect(() => {
    const mesh = wax.current;
    if (!mesh) return;
    CANDLES.forEach((c, i) => {
      dummy.position.set(c.p[0], c.p[1], c.p[2]);
      dummy.scale.set(c.r, c.h, c.r);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, []);

  useFrame(({ clock, size, viewport }) => {
    flames.material.uniforms.uTime.value = clock.elapsedTime;
    flames.material.uniforms.uChandelier.value = lampLevels.salon;
    // Hauteur du rendu en pixels : la taille d'un point en dépend.
    flames.material.uniforms.uPixelRatio.value = (size.height * viewport.dpr) / 2;
  });

  return (
    <group>
      <instancedMesh ref={wax} args={[waxGeometry, waxMaterial, CANDLES.length]} castShadow={false} />
      <points geometry={flames.geometry} material={flames.material} frustumCulled={false} renderOrder={5} />
    </group>
  );
}
