"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * L'appui long d'un doigt, et son équivalent au bureau — le clic droit et la touche menu du
 * clavier, que le navigateur rend tous deux en `contextmenu`.
 *
 * Écrit pour « Retirer de Reprendre » (23/09/2026) : une action rare, qu'on ne veut pas voir sur la
 * carte, et qu'on trouve là où on la cherche. Un demi-seconde sans bouger ; un doigt qui glisse fait
 * défiler la rangée, pas le menu. Le clic qui suit l'appui long est avalé — sans quoi relâcher le
 * doigt ouvrirait aussi le film.
 */
const HOLD_MS = 500;
const MOVE_TOLERANCE_PX = 10;

export function useLongPress(onLongPress: (() => void) | undefined) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  if (!onLongPress) return {};

  return {
    onPointerDown: (e: React.PointerEvent) => {
      // La souris a son clic droit ; l'appui long est celui du doigt et du stylet.
      if (e.pointerType === "mouse") return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        timer.current = null;
        onLongPress();
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const from = origin.current;
      if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      // Le doigt déclenche aussi `contextmenu` sur certains navigateurs : une seule ouverture.
      if (fired.current) return;
      cancel();
      onLongPress();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
