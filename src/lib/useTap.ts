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
/**
 * Le `click` de compatibilité qui suit un appui servi, s'il tombe **ailleurs** : retenu, une fois.
 *
 * Servir l'appui au relâchement ouvre la fiche avant que le navigateur n'envoie son `click` ; ce
 * clic vise alors ce qui se trouve *désormais* sous le doigt — « Lire » ou « Bande-annonce » de la
 * fiche en train de grandir. Sur Android, un appui sur une affiche sur deux, dans la bande
 * verticale concernée, lançait ainsi le film (passe de nuit du 15/10/2026, ROBUSTESSE-1).
 *
 * La pilule du bas avait déjà la même parade (`swallowNextClick`, `liquid.ts`). Trois bornes pour
 * ne jamais avaler un vrai geste : le délai de l'écho, le prochain `pointerdown` (un nouvel appui
 * commence : le clic de l'ancien, s'il devait venir, serait déjà passé — iOS l'annule parfois), et
 * un clic sans `detail` (clavier, `element.click()`), qui n'est pas l'écho d'un doigt. Un clic sur le
 * bouton lui-même passe : `onClick` sait déjà ne pas rejouer l'appui.
 */
function swallowEchoElsewhere(origin: Element | null): void {
  if (typeof window === "undefined") return;
  const disarm = () => {
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("pointerdown", disarm, true);
    window.clearTimeout(timer);
  };
  const onClick = (e: MouseEvent) => {
    disarm();
    if (e.detail === 0) return;
    if (origin && e.target instanceof Node && origin.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const timer = window.setTimeout(disarm, CLICK_ECHO_MS);
  window.addEventListener("click", onClick, true);
  window.addEventListener("pointerdown", disarm, true);
}

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
      // Armé avant l'action : c'est elle qui ouvre la fiche dont un bouton recevrait l'écho.
      swallowEchoElsewhere(e.currentTarget instanceof Element ? e.currentTarget : null);
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
