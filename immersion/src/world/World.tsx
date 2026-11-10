import { Suspense, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { NoToneMapping, SRGBColorSpace } from "three";
import { useStore } from "../state/store";
import { PLAYER } from "./layout";
import { Controls } from "./Controls";
import { Player } from "./Player";
import { Chalet } from "./Chalet";
import { SceneReady } from "./SceneReady";

/** Vrai tant que l'onglet est masqué : le rendu s'arrête alors tout à fait. */
function useHidden(): boolean {
  const [hidden, setHidden] = useState(document.visibilityState === "hidden");
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

/**
 * Le monde : le canevas WebGL, la physique, le visiteur, le chalet.
 *
 * Monté dès le chargement, sous l'écran d'accueil : c'est en se montant que la scène charge ses
 * textures et compile ses programmes, et l'accueil en affiche la progression réelle.
 */
export function World() {
  const hidden = useHidden();
  const fov = useStore((s) => s.settings.fov);
  const setPhase = useStore((s) => s.setPhase);

  return (
    <Canvas
      className="world"
      frameloop={hidden ? "never" : "always"}
      dpr={1}
      shadows
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: "high-performance" }}
      camera={{ fov, near: 0.06, far: 600, position: [PLAYER.spawn[0], PLAYER.eye, PLAYER.spawn[2]] }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = SRGBColorSpace;
        // Le mappage de tons est fait par le post-traitement (AgX), pas par le moteur.
        gl.toneMapping = NoToneMapping;
        // Le contexte perdu (pilote relancé, trop d'onglets 3D) : on le dit, plutôt qu'une image figée.
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          setPhase("lost");
        });
      }}
    >
      <Suspense fallback={null}>
        <Physics gravity={[0, -9.81, 0]} timeStep="vary">
          <Chalet />
          <Player />
        </Physics>
        <Controls />
        <SceneReady />
      </Suspense>
    </Canvas>
  );
}
