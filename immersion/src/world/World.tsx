import { Suspense, useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { NoToneMapping, PCFShadowMap, SRGBColorSpace } from "three";
import { PerformanceMonitor } from "@react-three/drei";
import { isTouchDevice } from "../lib/capability";
import { SUPERSAMPLING } from "../lib/settings";
import { Effects } from "./Effects";
import { useProfile, useStore } from "../state/store";
import { PLAYER } from "./layout";
import { InputDevices } from "./InputDevices";
import { Player } from "./Player";
import { Chalet } from "./Chalet";
import { SceneReady } from "./SceneReady";
import { PanelAnchor } from "./PanelAnchor";
import { installScreenLight } from "./screenLight";

// Avant toute matière : la lumière des écrans se greffe sur toutes les matières « standard ».
installScreenLight();

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
  const touch = useMemo(() => isTouchDevice(), []);
  // « Auto » ne s'ajuste pas pendant une mesure : c'est elle qui tient le préréglage.
  const auto = useStore((s) => s.settings.quality === "auto" && !s.bench?.running);
  const supersampling = useStore((s) => s.settings.supersampling);
  const stepAuto = useStore((s) => s.stepAuto);
  // Avec la lumière précalculée, plus aucune ombre n'est calculée en temps réel.
  const baked = useStore((s) => s.baked);
  // La résolution de rendu : la native de l'écran, à l'échelle du profil — et au-delà seulement si
  // le suréchantillonnage est demandé.
  // Un téléphone annonce trois points par pixel : rendu tel quel, ce serait plus de points qu'un écran d'ordinateur
  // pour une puce bien moins forte. Au doigt, la densité est plafonnée.
  const dpr = Math.min(touch ? 1.5 : 3, (window.devicePixelRatio || 1) * profile.scale * (supersampling ? SUPERSAMPLING : 1));

  return (
    <Canvas
      className="world"
      frameloop={hidden ? "never" : "always"}
      dpr={Math.max(0.4, dpr)}
      shadows={profile.shadowMap > 0 && !baked ? { type: PCFShadowMap } : false}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: "high-performance" }}
      camera={{ fov, near: 0.06, far: 3000, position: [PLAYER.spawn[0], PLAYER.eye, PLAYER.spawn[2]] }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = SRGBColorSpace;
        // Le mappage de tons est fait par le post-traitement (AgX), pas par le moteur.
        gl.toneMapping = NoToneMapping;
        // Le contexte perdu (pilote relancé, trop d'onglets 3D) : on le dit, plutôt qu'une image figée.
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          // Sauf quand on s'en va : en quittant, le monde est démonté et rend lui-même son contexte — l'écran
          // « Le rendu 3D s'est interrompu » passait alors une fraction de seconde avant l'application.
          const phase = useStore.getState().phase;
          if (phase !== "leaving" && phase !== "expired") setPhase("lost");
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
