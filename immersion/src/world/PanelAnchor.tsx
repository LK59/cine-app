import { useRef } from "react";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import type { Group, PerspectiveCamera } from "three";
import { flatPanel } from "../lib/capability";
import { useStore } from "../state/store";
import { Panel } from "../ui/Panel";
import { PANEL, panelPose, panelScale } from "./panel";

/**
 * Le panneau dans le monde : du vrai DOM, placé en perspective par drei (`<Html transform>`).
 *
 * Du DOM plutôt qu'une texture : le texte reste net, le champ de recherche est un vrai champ, les
 * affiches sont de simples `<img>`. L'occultation ne se pose pas — le panneau s'ouvre devant le
 * visiteur, qui ne bouge pas tant qu'il est ouvert.
 *
 * Il tient toujours en entier dans le champ : trop près d'un mur pour reculer, il est réduit (`panelScale`).
 */
export function PanelAnchor() {
  const open = useStore((s) => s.phase === "world" && s.mode === "panel");
  const group = useRef<Group>(null);
  useFrame(({ camera }) => {
    const anchor = group.current;
    if (!anchor) return;
    const view = camera as PerspectiveCamera;
    const scale = panelScale(view.position, view.fov, view.aspect);
    if (Math.abs(anchor.scale.x - scale) > 0.001) anchor.scale.setScalar(scale);
  });
  // Petit écran tactile : le panneau est dessiné à plat, par-dessus le monde (`App`).
  if (!open || flatPanel()) return null;
  return (
    <group ref={group} position={panelPose.position} rotation-y={panelPose.yaw}>
      <Html transform distanceFactor={(PANEL.width / PANEL.pixels) * 400} zIndexRange={[8, 0]} pointerEvents="auto" style={{ width: PANEL.pixels, height: PANEL.height }}>
        <Panel />
      </Html>
    </group>
  );
}
