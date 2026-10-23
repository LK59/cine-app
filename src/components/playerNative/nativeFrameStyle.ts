// Le style du cadre du lecteur natif (`ExperimentalPlayerHost.tsx`) : mini-lecteur déplaçable ou
// plein écran, sorti tel quel de son rendu le 23/10/2026.
import type { CSSProperties } from "react";
import { PLAYER_FRAME_TRANSITION } from "@/lib/playerFrame";

const TRANSITION = PLAYER_FRAME_TRANSITION;

export function nativeFrameStyle({
  isMini,
  pos,
  size,
  isDragging,
  resizing,
  revealed,
  closing,
}: {
  isMini: boolean;
  pos: { x: number; y: number };
  size: { width: number; height: number };
  isDragging: boolean;
  resizing: boolean;
  revealed: boolean;
  closing: boolean;
}): CSSProperties {
  return isMini
    ? {
        position: "fixed",
        top: pos.y,
        left: pos.x,
        width: size.width,
        height: size.height,
        borderRadius: 16,
        zIndex: 80,
        overflow: "hidden",
        boxShadow: "0 10px 30px rgba(0,0,0,.5)",
        transition: isDragging || resizing ? "none" : TRANSITION,
        touchAction: "none",
      }
    : {
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        borderRadius: 0,
        zIndex: 80,
        background: "black",
        transition: resizing
          ? "opacity 220ms ease-out, transform 220ms cubic-bezier(0.32, 0.72, 0, 1)"
          : `${TRANSITION}, opacity 220ms ease-out, transform 220ms cubic-bezier(0.32, 0.72, 0, 1)`,
        opacity: revealed && !closing ? 1 : 0,
        // Une échelle très légère : assez pour que l'œil suive le passage d'un écran à l'autre,
        // pas assez pour que ça ressemble à un effet.
        transform: revealed && !closing ? "scale(1)" : "scale(0.985)",
      };
}
