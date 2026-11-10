import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { applyAcoustics, audio } from "../media/audio";
import { syncMix } from "../media/playback";
import { useStore } from "../state/store";
import { CHANDELIER, ROOM } from "./layout";
import { rig } from "./rig";

/**
 * Ce que le visiteur entend d'où il est : `cutoff` est la fréquence au-delà de laquelle le son de la
 * télévision ne lui parvient plus.
 *
 * Dans le salon, rien n'est filtré. Sous la mezzanine, la pièce est ouverte sur le salon : le son
 * arrive encore clair. Plus loin, derrière un mur, il ne reste que les graves.
 */
export function acousticsAt(x: number, z: number): number {
  if (z <= ROOM.south + 0.2) return 20000;
  const depth = Math.min(1, (z - ROOM.south) / (ROOM.back - ROOM.south));
  const lateral = Math.abs(x) > ROOM.halfW ? 0.25 : 1;
  return (9000 - depth * 5200) * lateral;
}

/**
 * L'oreille et les sons d'ambiance : l'écoute est accrochée à la caméra, le vent à la baie, le
 * grésillement des bougies au lustre. Le haut-parleur de la télévision est posé par `Television`.
 */
export function SoundScape() {
  const camera = useThree((s) => s.camera);
  const graph = useMemo(() => audio(), []);
  const volume = useStore((s) => s.settings.volume);
  const spatial = useStore((s) => s.settings.spatial);
  const reverb = useStore((s) => s.settings.reverb);
  const muted = useStore((s) => s.playback.muted);

  useEffect(() => {
    camera.add(graph.listener);
    return () => {
      camera.remove(graph.listener);
    };
  }, [camera, graph]);

  useEffect(() => {
    syncMix();
  }, [volume, spatial, reverb, muted]);

  useFrame(() => applyAcoustics(acousticsAt(rig.position.x, rig.position.z)));

  return (
    <>
      <primitive object={graph.wind} position={[0, 2.6, ROOM.north - 0.6]} />
      <primitive object={graph.candles} position={[CHANDELIER.x, CHANDELIER.y, CHANDELIER.z]} />
    </>
  );
}
