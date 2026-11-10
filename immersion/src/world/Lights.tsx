import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { PointLight } from "three";
import { useProfile } from "../state/store";
import { BREAST, CHANDELIER, LAMPS, ROOM } from "./layout";
import { MOONLIGHT_FROM } from "./Exterior";

/**
 * L'éclairage : chaud dedans, froid dehors.
 *
 * Peu de lumières, exprès — chaque lumière ponctuelle se paie à chaque pixel de chaque matière :
 * - le **lustre** : une seule lumière pour ses vingt-six bougies, qui porte les ombres de la pièce ;
 * - les deux **lampadaires** et deux lumières rasantes au pied du mur de pierre (son relief ne se
 *   lit que sous une lumière qui le frôle) — coupées au préréglage le plus bas ;
 * - la **lune** : une lumière directionnelle bleutée qui entre par la baie et pose l'ombre des
 *   petits bois sur le parquet ;
 * - un ciel très faible pour que rien ne soit jamais tout à fait noir.
 *
 * Les ombres sont calculées une fois puis figées (`Atmosphere`) : rien ne bouge dans la pièce.
 */
export function Lights() {
  const profile = useProfile();
  const chandelier = useRef<PointLight>(null);
  const shadows = profile.shadowMap > 0;
  const cubeSize = Math.min(1024, profile.shadowMap);
  const lampY = 1.5;
  const base = useMemo(() => ({ chandelier: 210 }), []);

  useFrame(({ clock }) => {
    // Le souffle des bougies : quelques pour cent, lentement — sensible, jamais clignotant.
    const t = clock.elapsedTime;
    const flicker = 1 + 0.035 * Math.sin(t * 7.3) + 0.025 * Math.sin(t * 12.7 + 1.3) + 0.02 * Math.sin(t * 3.1 + 0.4);
    if (chandelier.current) chandelier.current.intensity = base.chandelier * flicker;
  });

  return (
    <group>
      <hemisphereLight args={["#6f8fd0", "#2a1d14", 0.22]} />

      <pointLight
        ref={chandelier}
        position={[CHANDELIER.x, CHANDELIER.y + 0.42, CHANDELIER.z]}
        color="#ffc98f"
        intensity={base.chandelier}
        distance={18}
        decay={2}
        castShadow={shadows}
        shadow-mapSize={[cubeSize || 256, cubeSize || 256]}
        shadow-bias={-0.004}
        shadow-normalBias={0.03}
        shadow-camera-near={0.3}
        shadow-camera-far={24}
      />

      {profile.fillLights ? (
        <>
          {LAMPS.map(([x, z], i) => (
            <pointLight key={i} position={[x, lampY, z]} color="#ffd0a0" intensity={18} distance={9} decay={2} />
          ))}
          <pointLight position={[BREAST.face - 0.75, 0.75, BREAST.z0 + 0.5]} color="#ffa055" intensity={9} distance={6.5} decay={2} />
          <pointLight position={[BREAST.face - 0.75, 0.75, BREAST.z1 - 0.5]} color="#ffa055" intensity={9} distance={6.5} decay={2} />
          {/* La partie sud, sous la mezzanine : une lumière d'appoint, en attendant la cuisine. */}
          <pointLight position={[0.5, 2.2, ROOM.south + 3]} color="#ffb672" intensity={14} distance={9} decay={2} />
        </>
      ) : (
        <pointLight position={[-3.2, lampY, CHANDELIER.z]} color="#ffbd7a" intensity={20} distance={11} decay={2} />
      )}

      <directionalLight
        position={[MOONLIGHT_FROM.x, MOONLIGHT_FROM.y, MOONLIGHT_FROM.z - 4]}
        target-position={[0, 0, -4]}
        color="#8fb2ff"
        intensity={1.15}
        castShadow={shadows}
        shadow-mapSize={[profile.shadowMap || 256, profile.shadowMap || 256]}
        shadow-bias={-0.0006}
        shadow-normalBias={0.04}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
        shadow-camera-near={4}
        shadow-camera-far={50}
      />
    </group>
  );
}
