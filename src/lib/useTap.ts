"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";

/** Plus loin que ça, le doigt a glissé : c'était un défilement, pas un appui. */
const TAP_SLOP_PX = 10;
/** Plus long, c'est un appui long — il a d'autres usages. */
const TAP_MAX_MS = 700;
/** Le clic qui suit un appui déjà servi arrive dans cette fenêtre. */
const CLICK_ECHO_MS = 700;

/**
 * Un appui servi au relâchement du doigt, pas au `click` (04/10/2026).
 *
 * Au bout d'une page qu'on vient de faire défiler, iOS garde le premier `click` pour arrêter l'élan
 * du défilement : « Voir tous les films » demandait deux appuis. Le relâchement, lui, arrive
 * toujours. Un doigt qui a glissé (au-delà de 10 px) ou qui est resté longtemps n'est pas un appui ;
 * un défilement repris par le navigateur (`pointercancel`) non plus. Le `click` reste branché pour le
 * clavier et la souris, et ne rejoue pas un appui déjà servi.
 */
export function useTap(action: () => void) {
  const start = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  const servedAt = useRef(0);
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      start.current = e.pointerType === "mouse" ? null : { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
    },
    onPointerUp: (e: ReactPointerEvent) => {
      const s = start.current;
      start.current = null;
      if (!s || s.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP_PX || e.timeStamp - s.t > TAP_MAX_MS) return;
      servedAt.current = Date.now();
      action();
    },
    onPointerCancel: () => {
      start.current = null;
    },
    onClick: () => {
      if (Date.now() - servedAt.current < CLICK_ECHO_MS) return;
      action();
    },
  };
}
