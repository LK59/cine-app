import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { PointLight } from "three";
import { useProfile, useStore } from "../state/store";
import { breathe, setLampLevel, type LampGroup } from "./lightmaps";
import { lampLevels } from "./lampLevels";
import { BREAST, CHANDELIER, LAMPS, ROOM } from "./layout";
import { NIGHT_LAMPS } from "./geometry/night";
import { PENDANTS } from "./geometry/south";
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
 *
 * **Avec la lumière précalculée** (`lightmaps.ts`), presque tout cela disparaît : les murs, les sols,
 * la charpente et les meubles construits tiennent leur lumière — et leurs ombres, douces, avec les
 * rebonds — de leur lightmap. Il ne reste en temps réel que trois lumières sans ombre, pour les
 * reflets et pour les objets posés (plantes, fauteuil, bougies), et le souffle des bougies.
 */
const GROUPS: LampGroup[] = ["salon", "sud", "nuit"];
/** Ce qu'il reste des lampes pendant un film, et pendant sa pause. */
const CINEMA_PLAYING = 0.1;
const CINEMA_PAUSED = 0.45;

export function Lights() {
  const profile = useProfile();
  const chandelier = useRef<PointLight>(null);
  const baked = useStore((s) => s.baked);
  const shadows = profile.shadowMap > 0 && !baked;
  const cubeSize = Math.min(1024, profile.shadowMap);
  const lampY = 1.5;
  const base = useMemo(() => ({ chandelier: 210 }), []);

  const pendant = useRef<PointLight>(null);
  const bedside = useRef<PointLight>(null);
  const scene = useThree((three) => three.scene);

  useFrame(({ clock }, delta) => {
    // Le souffle des bougies : quelques pour cent, lentement — sensible, jamais clignotant.
    const t = clock.elapsedTime;
    const flicker = 1 + 0.035 * Math.sin(t * 7.3) + 0.025 * Math.sin(t * 12.7 + 1.3) + 0.02 * Math.sin(t * 3.1 + 0.4);

    // Le niveau des lampes, pièce par pièce : leurs interrupteurs, et le **mode cinéma** — quand un film
    // joue, elles baissent en deux secondes et l'écran prend le dessus ; en pause elles remontent à demi.
    const state = useStore.getState();
    const playback = state.playback;
    const film = state.settings.cinema && (playback.status === "playing" || playback.status === "paused" || playback.status === "loading");
    const dim = !film ? 1 : playback.status === "paused" || playback.wantPaused ? CINEMA_PAUSED : CINEMA_PLAYING;
    const ease = 1 - Math.exp(-Math.min(delta, 0.1) * 1.6);
    for (const group of GROUPS) {
      const target = (state.lamps[group] ? 1 : 0) * dim;
      lampLevels[group] += (target - lampLevels[group]) * ease;
      if (Math.abs(target - lampLevels[group]) < 0.002) lampLevels[group] = target;
      setLampLevel(group, lampLevels[group]);
    }
    if (chandelier.current) chandelier.current.intensity = base.chandelier * flicker * lampLevels.salon;
    if (pendant.current) pendant.current.intensity = 20 * lampLevels.sud;
    if (bedside.current) bedside.current.intensity = 12 * lampLevels.nuit;
    // Les reflets d'ambiance ont été capturés lampes allumées : ils baissent avec elles.
    scene.environmentIntensity = 0.5 * (0.3 + 0.7 * lampLevels.salon);
    if (baked) breathe(1 + (flicker - 1) * 0.6);
  });

  if (baked)
    return (
      <group>
        <hemisphereLight args={["#6f8fd0", "#2a1d14", 0.22]} />
        <pointLight ref={chandelier} position={[CHANDELIER.x, CHANDELIER.y + 0.42, CHANDELIER.z]} color="#ffc98f" intensity={base.chandelier} distance={18} decay={2} />
        {profile.fillLights ? (
          <>
            <pointLight ref={pendant} position={[PENDANTS[1][0], PENDANTS[1][1] - 0.15, PENDANTS[1][2]]} color="#ffcf9a" intensity={20} distance={8} decay={2} />
            <pointLight ref={bedside} position={[NIGHT_LAMPS.bedside[0][0] + 0.9, 1.25, (NIGHT_LAMPS.bedside[0][2] + NIGHT_LAMPS.bedside[1][2]) / 2]} color="#ffc083" intensity={12} distance={7.5} decay={2} />
          </>
        ) : null}
      </group>
    );

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
          {/* La cuisine : ses suspensions ; la mezzanine : sa lampe de lecture. */}
          <pointLight position={[PENDANTS[1][0], PENDANTS[1][1] - 0.15, PENDANTS[1][2]]} color="#ffcf9a" intensity={20} distance={8} decay={2} />
          <pointLight position={[1.2, ROOM.loft + 1.7, 7.4]} color="#ffc488" intensity={11} distance={8} decay={2} />
          {/* Le couloir : ses appliques ; la chambre : ses lampes de chevet. */}
          <pointLight position={[-2, 1.9, NIGHT_LAMPS.sconces[0][2] - 0.5]} color="#ffbf80" intensity={9} distance={6} decay={2} />
          <pointLight position={[NIGHT_LAMPS.bedside[0][0] + 0.9, 1.25, (NIGHT_LAMPS.bedside[0][2] + NIGHT_LAMPS.bedside[1][2]) / 2]} color="#ffc083" intensity={12} distance={7.5} decay={2} />
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
