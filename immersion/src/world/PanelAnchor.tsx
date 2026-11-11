import { Html } from "@react-three/drei";
import { flatPanel } from "../lib/capability";
import { useStore } from "../state/store";
import { Panel } from "../ui/Panel";
import { PANEL, panelPose } from "./panel";

/**
 * Le panneau dans le monde : du vrai DOM, placé en perspective par drei (`<Html transform>`).
 *
 * Du DOM plutôt qu'une texture : le texte reste net, le champ de recherche est un vrai champ, les
 * affiches sont de simples `<img>`. L'occultation ne se pose pas — le panneau s'ouvre devant le
 * visiteur, qui ne bouge pas tant qu'il est ouvert.
 */
export function PanelAnchor() {
  const open = useStore((s) => s.phase === "world" && s.mode === "panel");
  // Petit écran tactile : le panneau est dessiné à plat, par-dessus le monde (`App`).
  if (!open || flatPanel()) return null;
  return (
    <group position={panelPose.position} rotation-y={panelPose.yaw}>
      <Html transform distanceFactor={(PANEL.width / PANEL.pixels) * 400} zIndexRange={[8, 0]} pointerEvents="auto" style={{ width: PANEL.pixels, height: PANEL.height }}>
        <Panel />
      </Html>
    </group>
  );
}
