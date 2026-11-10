import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import { useStore } from "../state/store";
import { benchFrame, benchRun } from "../bench/bench";

/**
 * Dit à l'accueil que la scène est prête. Monté dans la même frontière `Suspense` que le chalet :
 * il n'existe donc qu'une fois tout chargé — puis il laisse passer quelques images, le temps que
 * les programmes soient compilés et les ombres calculées, pour que l'entrée ne saccade pas.
 */
export function SceneReady() {
  const frames = useRef(0);
  const setSceneReady = useStore((s) => s.setSceneReady);
  useFrame(() => {
    // Une mesure en cours chronomètre chaque image (`bench/bench.ts`).
    benchFrame(performance.now());
    if (frames.current < 0) return;
    frames.current += 1;
    if (frames.current >= 8) {
      frames.current = -1;
      setSceneReady(true);
    }
  });
  useEffect(() => () => setSceneReady(false), [setSceneReady]);
  // La scène et le moteur, pour les tests et les captures (voir `window.__immersion` dans App).
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const handle = (window as unknown as { __immersion?: Record<string, unknown> }).__immersion;
    if (handle) Object.assign(handle, { scene, gl });
    benchRun.gl = gl;
    return () => {
      benchRun.gl = null;
    };
  }, [scene, gl]);
  return null;
}
