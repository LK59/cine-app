import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { ConeGeometry, MeshStandardMaterial, SphereGeometry, TorusGeometry, type Group } from "three";
import { audio } from "../media/audio";
import { useStore } from "../state/store";
import { CAT } from "./interactions";
import { visibleGroups } from "./Parts";
import { rig } from "./rig";
import { applyScreenLight } from "./screenLight";

/** Un pelage tigré : des bandes sombres irrégulières, dessinées par le programme de la matière. */
function tabby(material: MeshStandardMaterial): MeshStandardMaterial {
  material.onBeforeCompile = (shader) => {
    applyScreenLight(shader);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
      {
        vec3 w = vSlWorld * 55.0;
        float bands = sin( w.x * 1.3 + sin( w.z * 0.9 + w.y * 1.7 ) * 1.6 );
        diffuseColor.rgb *= mix( 0.5, 1.0, smoothstep( -0.1, 0.6, bands ) );
      }`
    );
  };
  material.customProgramCacheKey = () => "pelage-tigre";
  return material;
}

/**
 * Le chat : roulé en boule sur le pouf, près du feu. Il dort — ses flancs se soulèvent —, ronronne
 * quand on s'approche, et plus fort quand on le caresse (une oreille bouge, la queue se replace).
 *
 * Un chat endormi est le seul qu'on puisse faire de quelques sphères sans qu'il ait l'air faux : le
 * corps est un ovale bas, la tête rentrée contre le flanc, la queue ramenée autour de lui.
 */
export function Cat() {
  const room = useStore((s) => s.room);
  const graph = useMemo(() => audio(), []);
  const body = useRef<Group>(null);
  const ear = useRef<Group>(null);
  const tail = useRef<Group>(null);
  const purr = useRef(0);

  const parts = useMemo(
    () => ({
      // Un pelage gris tigré : mat, un peu chaud sous la lueur du feu.
      fur: tabby(new MeshStandardMaterial({ color: "#6f655a", roughness: 0.95 })),
      light: new MeshStandardMaterial({ color: "#8d8377", roughness: 0.95 }),
      inner: new MeshStandardMaterial({ color: "#8a6f68", roughness: 0.9 }),
      // La queue : un arc de tore fin.
      ring: new TorusGeometry(0.2, 0.021, 8, 26, Math.PI * 0.95),
      ball: new SphereGeometry(1, 20, 14),
      ear: new ConeGeometry(0.03, 0.058, 4),
    }),
    []
  );
  useEffect(
    () => () => {
      for (const m of [parts.fur, parts.light, parts.inner]) m.dispose();
      for (const g of [parts.ring, parts.ball, parts.ear]) g.dispose();
    },
    [parts]
  );

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const state = useStore.getState();
    // Le souffle : lent, à peine visible.
    const breath = 1 + 0.022 * Math.sin(t * 1.9);
    if (body.current) body.current.scale.set(1, breath, 1);
    // Caressé, il ronronne fort une dizaine de secondes ; sinon, seulement de près.
    const sincePet = (performance.now() - state.petAt) / 1000;
    const petted = state.petAt > 0 && sincePet < 10 ? 1 - sincePet / 10 : 0;
    const distance = Math.hypot(rig.eye.x - CAT.x, rig.eye.y - CAT.y, rig.eye.z - CAT.z);
    const target = Math.max(petted, distance < 1.6 ? 0.35 : 0);
    purr.current += (target - purr.current) * (1 - Math.exp(-Math.min(delta, 0.1) * 2));
    graph.purr.setVolume(purr.current * 0.9);
    if (ear.current) ear.current.rotation.z = petted > 0 ? Math.sin(t * 9) * 0.18 * petted : 0;
    if (tail.current) tail.current.rotation.y = petted > 0 ? Math.sin(t * 2.2) * 0.25 * petted : 0;
  });

  return (
    <group position={[CAT.x, CAT.y, CAT.z]} rotation-y={0.6} visible={visibleGroups(room).salon} name="cat">
      <group ref={body}>
        {/* Le corps : un ovale bas — le dos rond, les hanches ramenées. */}
        <mesh geometry={parts.ball} material={parts.fur} position={[-0.02, 0.078, 0]} scale={[0.19, 0.085, 0.145]} />
        <mesh geometry={parts.ball} material={parts.fur} position={[-0.11, 0.072, 0.03]} scale={[0.1, 0.078, 0.1]} />
      </group>
      {/* La tête, bien dégagée du corps, le menton sur les pattes de devant. */}
      <group position={[0.17, 0.085, 0.07]} rotation-y={-0.5}>
        <mesh geometry={parts.ball} material={parts.fur} scale={[0.068, 0.058, 0.066]} />
        {/* Le museau et le plastron, clairs. */}
        <mesh geometry={parts.ball} material={parts.light} position={[0.045, -0.018, 0]} scale={[0.036, 0.026, 0.038]} />
        <mesh geometry={parts.ball} material={parts.inner} position={[0.078, -0.012, 0]} scale={[0.008, 0.006, 0.009]} />
        <group ref={ear} position={[-0.005, 0.05, 0.038]}>
          <mesh geometry={parts.ear} material={parts.fur} rotation-x={0.28} />
          <mesh geometry={parts.ear} material={parts.inner} rotation-x={0.28} position={[0.008, -0.005, 0]} scale={[0.55, 0.7, 0.55]} />
        </group>
        <group position={[-0.005, 0.05, -0.038]}>
          <mesh geometry={parts.ear} material={parts.fur} rotation-x={-0.28} />
          <mesh geometry={parts.ear} material={parts.inner} rotation-x={-0.28} position={[0.008, -0.005, 0]} scale={[0.55, 0.7, 0.55]} />
        </group>
      </group>
      {/* Les pattes de devant, sous le menton. */}
      <mesh geometry={parts.ball} material={parts.light} position={[0.2, 0.024, 0.02]} scale={[0.05, 0.022, 0.026]} rotation-y={-0.3} />
      <mesh geometry={parts.ball} material={parts.light} position={[0.19, 0.024, 0.08]} scale={[0.05, 0.022, 0.026]} rotation-y={-0.6} />
      {/* La queue : un boudin fin qui fait le tour de la croupe et revient le long du flanc. */}
      <group ref={tail} position={[-0.03, 0.03, 0]}>
        <mesh geometry={parts.ring} material={parts.fur} rotation-x={-Math.PI / 2} rotation-z={2.4} scale={[1, 0.72, 1]} />
      </group>
      <primitive object={graph.purr} position={[0, 0.1, 0]} />
    </group>
  );
}
