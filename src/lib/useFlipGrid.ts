"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "@/lib/reducedMotion";

/**
 * Une grille qui se réorganise au lieu de sauter.
 *
 * Retirer un titre de « Ma liste », annuler une demande : la carte disparaissait et toutes les
 * suivantes se replaçaient d'un coup, d'un cran vers la gauche ou d'une ligne vers le haut — la
 * grille sautait (23/09/2026). Les voisines glissent désormais jusqu'à leur nouvelle place, et une
 * carte ajoutée apparaît en se posant.
 *
 * La technique est dite FLIP : après la mise à jour et avant que l'écran ne soit dessiné, on lit
 * où chaque carte se trouve, on la replace instantanément là où elle était, puis on la laisse
 * glisser jusqu'à sa vraie place. Positions lues par `offsetLeft` / `offsetTop` — relatives à la
 * grille, donc insensibles au défilement entre deux mises à jour.
 *
 * Seulement pour un **petit** changement — au plus trois cartes ajoutées ou retirées. Changer
 * d'onglet, de tri, filtrer : c'est un autre contenu, pas une réorganisation, et le montrer en
 * mouvement ne ferait que du bruit. Seulement les cartes à l'écran, et rien du tout quand
 * l'appareil demande moins de mouvement.
 *
 * `keys` : l'identité de chaque enfant de la grille, dans l'ordre du DOM.
 */
const MAX_CHANGED = 3;
const MOVE_MS = 280;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

export function useFlipGrid(gridRef: RefObject<HTMLElement | null>, keys: string[]): void {
  const previous = useRef<Map<string, { x: number; y: number }> | null>(null);
  const signature = keys.join("\u0000");

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      previous.current = null;
      return;
    }
    const children = Array.from(grid.children) as HTMLElement[];
    const now = new Map<string, { x: number; y: number; el: HTMLElement }>();
    children.forEach((el, i) => {
      const key = keys[i];
      if (key !== undefined) now.set(key, { x: el.offsetLeft, y: el.offsetTop, el });
    });

    const before = previous.current;
    previous.current = new Map([...now].map(([k, v]) => [k, { x: v.x, y: v.y }]));
    if (!before || prefersReducedMotion() || typeof grid.animate !== "function") return;

    let added = 0;
    for (const k of now.keys()) if (!before.has(k)) added++;
    let removed = 0;
    for (const k of before.keys()) if (!now.has(k)) removed++;
    if (added + removed === 0 || added + removed > MAX_CHANGED) return;

    const viewTop = -window.innerHeight;
    const viewBottom = window.innerHeight * 2;
    for (const [k, { x, y, el }] of now) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < viewTop || rect.top > viewBottom) continue;
      const from = before.get(k);
      if (!from) {
        el.animate([{ opacity: 0, transform: "scale(0.92)" }, { opacity: 1, transform: "none" }], {
          duration: MOVE_MS,
          easing: EASE,
        });
        continue;
      }
      const dx = from.x - x;
      const dy = from.y - y;
      if (dx === 0 && dy === 0) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: MOVE_MS, easing: EASE });
    }
    // `keys` est lu par sa signature : un tableau neuf à chaque rendu ne doit pas relancer ceci.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, gridRef]);
}
