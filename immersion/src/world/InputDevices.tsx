import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { view } from "../input/intents";
import { attachKeyboardMouse, movementKeyLabels } from "../input/keyboardMouse";
import { captureChanged, listenIntents } from "../state/actions";
import { useStore } from "../state/store";
import { look } from "./rig";

/**
 * Branche le périphérique d'entrée du jour — clavier et souris — sur le canevas, et les actions sur
 * les intentions. Le reste du monde ne voit ni touche ni souris : seulement `motion`, le regard
 * (`rig`) et les actions.
 */
export function InputDevices() {
  const canvas = useThree((s) => s.gl.domElement);
  useEffect(() => {
    const stopIntents = listenIntents();
    const detach = attachKeyboardMouse({
      canvas,
      // Image rapprochée, regard ralenti d'autant : le même geste déplace l'image de la même distance à l'écran.
      onLook: (dx, dy) => look(dx, dy, useStore.getState().settings.sensitivity * view.scale),
      onCapture: captureChanged,
      worldActive: () => {
        const state = useStore.getState();
        return state.phase === "world" && state.mode === "walk";
      },
      layout: () => useStore.getState().settings.keyboard,
      onLayoutSeen: (label) => useStore.getState().setKeysSeen(label),
    });
    // Ce que le navigateur sait dire de la disposition, quand il sait (sinon : la langue, puis la première touche).
    void movementKeyLabels().then((label) => useStore.getState().keysSeen === null && useStore.getState().setKeysSeen(label));
    return () => {
      detach();
      stopIntents();
    };
  }, [canvas]);
  return null;
}
