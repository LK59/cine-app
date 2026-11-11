import { Suspense, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { NoToneMapping, PCFShadowMap, SRGBColorSpace } from "three";
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
import { AutoQuality } from "./AutoQuality";
import { loadPacks } from "../lib/packs";
import { reportContextLost } from "../lib/errorLog";

// Avant toute matière : la lumière des écrans se greffe sur toutes les matières « standard ».
installScreenLight();

/**
 * Rien de ce qui charge un décor ne se monte avant les paquets (`lib/packs.ts`) : un chargeur parti plus tôt irait
 * chercher son fichier seul — c'est ce que le pare-feu punit, et le fichier n'est plus dans le build. Les enfants
 * ne sont même pas rendus d'avance : React prépare sinon les frères d'un composant suspendu.
 */
function PacksReady({ children }: { children: ReactNode }) {
  use(loadPacks());
  return children;
}

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
  const supersampling = useStore((s) => s.settings.supersampling);
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
          const state = useStore.getState();
          const phase = state.phase;
          if (phase === "leaving" || phase === "expired") return;
          // Au journal : « des écrans noirs en marchant » chez un visiteur n'avaient laissé aucune trace. L'instant, la
          // phase, la qualité et la pièce aident à dire si c'est la machine (mémoire, pilote) ou un endroit du chalet.
          reportContextLost(`${Math.round(performance.now() / 1000)} s, phase ${phase}, qualité ${state.settings.quality}${state.settings.quality === "auto" ? ` niveau ${state.autoLevel}` : ""}, pièce ${state.room}`);
          setPhase("lost");
        });
      }}
    >
      {/* « Auto » : la qualité suit la machine dans les deux sens (`AutoQuality`) ; il ne fait rien sous un préréglage
          choisi à la main, ni pendant une mesure. */}
      <AutoQuality />
      <Suspense fallback={null}>
        <PacksReady>
          <Physics gravity={[0, -9.81, 0]} timeStep="vary">
            <Chalet />
            <Player />
          </Physics>
          <InputDevices />
          <PanelAnchor />
          <Effects />
          <SceneReady />
        </PacksReady>
      </Suspense>
    </Canvas>
  );
}
