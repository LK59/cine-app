"use client";

import { useEffect, useRef, type RefObject } from "react";
import { createLiquidPress } from "./liquid";

/**
 * Le geste liquide branché par délégation sur tout ce qu'un écran marque (DECISIONS.md §45).
 *
 * - `data-liquid` : le geste complet des commandes du lecteur — gonfle, s'étire vers le doigt,
 *   marge de toucher élargie (globals.css). Pour ce qui n'est dans rien qu'on fasse glisser : une
 *   croix sur une image, une barre.
 * - `data-liquid-pan="wide"` : un grand bouton dans une page qui défile — geste doux, le défilement
 *   vertical reste au navigateur (`touch-action: pan-y`).
 * - `data-liquid-pan="icon"` : un petit bouton (À voir, Vu) — à peine un rebond.
 * - `data-liquid-pan="press"` : un bouton posé dans ce qu'on fait glisser dans les deux sens (le
 *   carrousel de la bannière) — il gonfle et rebondit, et rend la main dès que le doigt bouge.
 *
 * Le clic natif n'est jamais remplacé (`createLiquidPress`). Un bouton désactivé ne bouge pas.
 */
export function useLiquidDelegation(rootRef: RefObject<HTMLElement | null>): void {
  // Branché sur l'élément du moment : une bannière vide au premier rendu (catalogue pas encore là)
  // n'a pas d'élément, et le gagne au rendu suivant. Relu après chaque rendu — une comparaison de
  // référence, rien de plus quand il n'a pas changé.
  const attached = useRef<{ root: HTMLElement; dispose: () => void } | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (attached.current?.root === root) return;
    attached.current?.dispose();
    attached.current = null;
    if (!root) return;
    const targets = "[data-liquid], [data-liquid-pan]";
    const full = createLiquidPress({ targets });
    const wide = createLiquidPress({ targets, strength: 0.6 });
    const icon = createLiquidPress({ targets, strength: 0.5, swell: (w, h) => Math.min(1.08, 1 + 6 / Math.max(w, h, 1)) });
    const press = createLiquidPress({ targets, strength: 0.4, yieldAfter: 8 });
    const onDown = (e: PointerEvent) => {
      const surface = (e.target as Element | null)?.closest?.<HTMLElement>(targets);
      if (!surface || !root.contains(surface) || surface.matches(":disabled")) return;
      const kind = surface.getAttribute("data-liquid-pan");
      (kind === "icon" ? icon : kind === "wide" ? wide : kind === "press" ? press : full).down(e, surface);
    };
    root.addEventListener("pointerdown", onDown);
    attached.current = {
      root,
      dispose: () => {
        root.removeEventListener("pointerdown", onDown);
        full.dispose();
        wide.dispose();
        icon.dispose();
        press.dispose();
      },
    };
  });
  useEffect(
    () => () => {
      attached.current?.dispose();
      attached.current = null;
    },
    [],
  );
}
