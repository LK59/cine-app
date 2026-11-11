import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import { useStore } from "../state/store";
import { benchFrame, benchRun } from "../bench/bench";
import { packsSettled, releasePacks } from "../lib/packs";
import { warmUp } from "./warmup";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Dit à l'accueil que la scène est prête. Monté dans la même frontière `Suspense` que le chalet :
 * il n'existe donc qu'une fois tout chargé. Il attend encore ce qui se lit hors de `Suspense` (lumière
 * précalculée, panorama : `holdPacks`), prépare toute la scène (`warmUp` : programmes et textures de
 * toutes les pièces), laisse passer quelques images, puis rend la mémoire des paquets (`releasePacks`).
 */
export function SceneReady() {
  const frames = useRef(0);
  /** `false` tant que la préparation n'est pas faite ; les images ne comptent qu'ensuite. */
  const warmed = useRef(false);
  const setSceneReady = useStore((s) => s.setSceneReady);
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    let alive = true;
    void (async () => {
      await packsSettled();
      // Deux images : ce que la lumière et le panorama viennent de changer est monté — puis ce qui serait arrivé entre-temps.
      await nextFrame();
      await nextFrame();
      await packsSettled();
      if (!alive) return;
      await warmUp(gl, scene, camera).catch((error) => console.warn("[immersion] préparation de la scène incomplète", error));
      if (alive) warmed.current = true;
    })();
    return () => {
      alive = false;
    };
  }, [gl, scene, camera]);
  useFrame(() => {
    // Une mesure en cours chronomètre chaque image (`bench/bench.ts`).
    benchFrame(performance.now());
    if (!warmed.current || frames.current < 0) return;
    frames.current += 1;
    if (frames.current >= 8) {
      frames.current = -1;
      setSceneReady(true);
      releasePacks();
    }
  });
  useEffect(() => () => setSceneReady(false), [setSceneReady]);
  // La scène et le moteur, pour les tests et les captures (voir `window.__immersion` dans App).
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
