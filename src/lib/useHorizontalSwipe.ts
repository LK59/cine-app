"use client";

import { useCallback, useRef, type CSSProperties } from "react";

/**
 * Un balayage horizontal, sans prendre le défilement vertical à la page.
 *
 * `touch-action: pan-y` est la clé : le navigateur garde le défilement vers le haut et le bas —
 * qu'on ne veut surtout pas confisquer sur un écran qui défile — et nous laisse l'axe
 * horizontal. Un geste dont la composante verticale domine est abandonné dès le premier
 * déplacement : c'est un défilement, pas un balayage.
 *
 * Se déclenche une seule fois par geste, au franchissement du seuil, plutôt qu'au relâchement :
 * l'écran répond pendant que le doigt est encore là, ce qui est la moitié de la sensation.
 */
const THRESHOLD_PX = 48;

export function useHorizontalSwipe(onSwipe: (direction: 1 | -1) => void) {
  const from = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    from.current = { x: e.clientX, y: e.clientY };
    fired.current = false;
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = from.current;
      if (!start || fired.current) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      // La page défile : ce geste ne nous appartient pas, et le reprendre en cours de route
      // ferait sauter l'affiche pendant qu'on lit ce qu'il y a en dessous.
      if (Math.abs(dy) > Math.abs(dx)) {
        from.current = null;
        return;
      }
      if (Math.abs(dx) < THRESHOLD_PX) return;
      fired.current = true;
      onSwipe(dx < 0 ? 1 : -1);
    },
    [onSwipe]
  );

  const end = useCallback(() => {
    from.current = null;
  }, []);

  return {
    /** À poser sur l'élément : sans lui, le navigateur garde le geste pour son propre défilement. */
    style: { touchAction: "pan-y" } as CSSProperties,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onPointerLeave: end,
    },
  };
}
