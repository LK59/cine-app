import { Vector3 } from "three";
import { useStore } from "../state/store";
import { lockPointer, unlockPointer } from "./Controls";
import { BREAST, TV } from "./layout";
import { rig } from "./rig";

/**
 * Où le panneau Laterna apparaît : devant le visiteur, entre lui et la télévision, tourné vers lui.
 *
 * Posé à l'ouverture puis immobile dans le monde : c'est un objet de la pièce, pas un calque collé à
 * l'écran. Sa distance (1,5 m) et sa largeur (2,5 m) sont réglées pour qu'un pixel de son contenu
 * fasse à peu près un pixel d'écran — en dessous, le texte fond.
 */
export const PANEL = { width: 2.5, pixels: 1180, height: 700, distance: 1.5 } as const;

export const panelPose = { position: new Vector3(), yaw: 0 };

/** Pour les tests sans écran, où le verrou du pointeur n'existe pas : ne pas retomber en pause. */
export const panelDebug = { skipLockCheck: false };

export function openPanel(): void {
  const state = useStore.getState();
  if (state.phase !== "world" || state.mode !== "walk" || !state.nearTv) return;
  const eye = rig.eye;
  // Vers l'écran, à l'horizontale — sauf tout contre lui, où le panneau reste devant la pierre.
  const toTv = new Vector3(TV.x - eye.x, 0, TV.z - eye.z);
  const room = Math.max(0.2, BREAST.face - 0.75 - eye.x);
  const direction = toTv.lengthSq() > 0.01 ? toTv.normalize() : new Vector3(1, 0, 0);
  const reach = direction.x > 0.05 ? Math.min(PANEL.distance, room / direction.x) : PANEL.distance;
  panelPose.position.copy(eye).addScaledVector(direction, Math.max(0.95, reach));
  panelPose.position.y = eye.y - 0.03;
  panelPose.yaw = Math.atan2(eye.x - panelPose.position.x, eye.z - panelPose.position.z);
  rig.aim = { yaw: Math.atan2(-(panelPose.position.x - eye.x), -(panelPose.position.z - eye.z)), pitch: -0.02 };
  // Le mode d'abord : la perte du verrou qui suit est voulue, elle ne doit pas ouvrir le menu pause.
  state.setMode("panel");
  unlockPointer();
}

/** Ferme le panneau et rend le regard à la souris. À appeler depuis un geste (clic, touche). */
export function closePanel(): void {
  const state = useStore.getState();
  if (state.mode !== "panel") return;
  rig.aim = null;
  state.setMode("walk");
  lockPointer();
  if (panelDebug.skipLockCheck) return;
  // Le navigateur peut refuser le verrou (juste après un Échap) : le menu pause propose alors de reprendre.
  setTimeout(() => {
    const now = useStore.getState();
    if (now.phase === "world" && now.mode === "walk" && !document.pointerLockElement) now.setMode("paused");
  }, 350);
}
