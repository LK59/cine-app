import { useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { useStore } from "../state/store";

/**
 * Dit à l'accueil que la scène est prête. Monté dans la même frontière `Suspense` que le chalet :
 * il n'existe donc qu'une fois tout chargé — puis il laisse passer quelques images, le temps que
 * les programmes soient compilés et les ombres calculées, pour que l'entrée ne saccade pas.
 */
export function SceneReady() {
  const frames = useRef(0);
  const setSceneReady = useStore((s) => s.setSceneReady);
  useFrame(() => {
    if (frames.current < 0) return;
    frames.current += 1;
    if (frames.current >= 8) {
      frames.current = -1;
      setSceneReady(true);
    }
  });
  useEffect(() => () => setSceneReady(false), [setSceneReady]);
  return null;
}
