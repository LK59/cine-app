import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { useStore } from "../state/store";
import { listenKeyboard, type Action } from "./input";
import { look, rig } from "./rig";
import { SOFA } from "./layout";
import { Vector3 } from "three";

/** Ce que les touches d'action déclenchent ; la lecture s'y branche à l'étape de la télévision. */
export const actions: { handlers: Partial<Record<Action, () => void>> } = { handlers: {} };

let canvasRef: HTMLCanvasElement | null = null;

/**
 * Demande le pointeur. À n'appeler que depuis un geste (clic, touche) : le navigateur refuse sinon,
 * et refuse aussi pendant la seconde qui suit un Échap — d'où le `catch`, et l'écran « Cliquer pour
 * reprendre » qui reste alors affiché.
 */
export function lockPointer(): void {
  const canvas = canvasRef;
  if (!canvas || document.pointerLockElement === canvas) return;
  try {
    const asked = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    asked?.catch?.(() => {});
  } catch {
    // Refusé : l'écran de reprise reste là, un nouveau clic réessaiera.
  }
}

export function unlockPointer(): void {
  if (document.pointerLockElement) document.exitPointerLock();
}

/**
 * Le pointeur verrouillé et le clavier.
 *
 * Échap ne parvient pas à la page tant que le pointeur est verrouillé : le navigateur le garde pour
 * rendre le pointeur. C'est donc la **perte du verrou** qui ouvre le menu pause — sauf si elle est
 * voulue (le panneau Laterna s'ouvre : le mode a déjà changé).
 */
export function Controls() {
  const canvas = useThree((s) => s.gl.domElement);

  useEffect(() => {
    canvasRef = canvas;
    const onLockChange = () => {
      const state = useStore.getState();
      if (document.pointerLockElement === canvas) state.setMode("walk");
      else if (state.phase === "world" && state.mode === "walk") state.setMode("paused");
    };
    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      // Chrome rend parfois un saut de plusieurs centaines de pixels au verrouillage : ignoré.
      if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
      look(e.movementX, e.movementY, useStore.getState().settings.sensitivity);
    };
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMove);

    const stopKeyboard = listenKeyboard(
      (action) => {
        const state = useStore.getState();
        if (action === "sit") {
          if (state.seated) state.setSeated(false);
          else if (state.nearSofa) {
            // Le corps va se poser devant le canapé : c'est là qu'on se relève.
            rig.teleport = new Vector3(...SOFA.standPoint);
            state.setSeated(true);
          }
          return;
        }
        actions.handlers[action]?.();
      },
      () => {
        const state = useStore.getState();
        return state.phase === "world" && state.mode === "walk";
      }
    );

    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMove);
      stopKeyboard();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      canvasRef = null;
    };
  }, [canvas]);

  return null;
}
