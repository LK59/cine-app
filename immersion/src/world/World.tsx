import { Suspense, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { NoToneMapping, PCFShadowMap, SRGBColorSpace } from "three";
import { PerformanceMonitor } from "@react-three/drei";
import { SUPERSAMPLING } from "../lib/settings";
import { Effects } from "./Effects";
import { useProfile, useStore } from "../state/store";
import { PLAYER } from "./layout";
import { InputDevices } from "./InputDevices";
import { Player } from "./Player";
import { Chalet } from "./Chalet";
import { SceneReady } from "./SceneReady";
import { PanelAnchor } from "./PanelAnchor";

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
  const profile = useProfile();
  const auto = useStore((s) => s.settings.quality === "auto");
  const supersampling = useStore((s) => s.settings.supersampling);
  const stepAuto = useStore((s) => s.stepAuto);
  // La résolution de rendu : la native de l'écran, à l'échelle du profil — et au-delà seulement si
  // le suréchantillonnage est demandé.
  const dpr = Math.min(3, (window.devicePixelRatio || 1) * profile.scale * (supersampling ? SUPERSAMPLING : 1));

  return (
    <Canvas
      className="world"
      frameloop={hidden ? "never" : "always"}
      dpr={Math.max(0.4, dpr)}
      shadows={profile.shadowMap > 0 ? { type: PCFShadowMap } : false}
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
      {/* « Auto » : le moniteur mesure les images par seconde ; en dessous de la cible il descend d'un
          niveau, avec de la marge il remonte. Un préréglage choisi à la main ne bouge pas. */}
      {auto ? <PerformanceMonitor bounds={(refresh) => (refresh > 90 ? [80, 110] : [50, 58])} flipflops={4} onDecline={() => stepAuto(1)} onIncline={() => stepAuto(-1)} /> : null}
      <Suspense fallback={null}>
        <Physics gravity={[0, -9.81, 0]} timeStep="vary">
          <Chalet />
          <Player />
        </Physics>
        <InputDevices />
        <PanelAnchor />
        <Effects />
        <SceneReady />
      </Suspense>
    </Canvas>
  );
}
