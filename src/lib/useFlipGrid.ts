"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "@/lib/reducedMotion";
import { rowsDelayMs } from "@/lib/heroCarousel";

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
 *
 * `options` (25/09/2026) : les rangées du cinéma s'en servent quand les données fraîches remplacent
 * celles du cache de l'appareil — voir `CATALOGUE_FLIP`. Sans options, rien ne change pour « Ma
 * liste » et les demandes.
 */
const MAX_CHANGED = 3;
const MOVE_MS = 280;
const FADE_MS = 320;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

export interface FlipOptions {
  /** Au-delà, ce n'est plus une réorganisation. Trois par défaut. */
  maxChanged?: number;
  /** Un léger décalage entre les cartes qui bougent, pour qu'elles ne partent pas en bloc. */
  staggerMs?: number;
  /**
   * Au-delà de `maxChanged`, un fondu de la rangée entière plutôt que rien — seulement si elle
   * garde au moins une carte en commun avec l'état d'avant : un contenu entièrement autre (un
   * onglet, un tri) reste un remplacement franc.
   */
  fadeBeyond?: boolean;
  /**
   * Compter aussi un simple changement d'ordre, sans carte ajoutée ni retirée : « Reprendre » dont
   * le film regardé sur la télé remonte en tête. Sans cela, ce cas ne bougeait pas du tout.
   */
  reorders?: boolean;
  /** Une attente avant de bouger, relue au moment d'animer — voir `rowsDelayMs`. */
  delayMs?: () => number;
}

/**
 * Les rangées d'affiches du cinéma quand les données fraîches arrivent après celles du cache : un
 * film arrivé cette nuit entre dans « Ajouts récents », celui qu'on vient de finir quitte
 * « Reprendre ». Jusqu'à huit cartes glissent, un peu décalées ; au-delà — après deux semaines sans
 * ouvrir l'application — la rangée se remplace en fondu au lieu de s'agiter. Et toujours après la
 * bannière, si elle change au même moment.
 */
export const CATALOGUE_FLIP: FlipOptions = {
  maxChanged: 8,
  staggerMs: 35,
  fadeBeyond: true,
  reorders: true,
  delayMs: () => rowsDelayMs(),
};

export function useFlipGrid(gridRef: RefObject<HTMLElement | null>, keys: string[], options: FlipOptions = {}): void {
  const { maxChanged = MAX_CHANGED, staggerMs = 0, fadeBeyond = false, reorders = false, delayMs } = options;
  const previous = useRef<Map<string, { x: number; y: number; order: number }> | null>(null);
  const signature = keys.join("\u0000");

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      previous.current = null;
      return;
    }
    const children = Array.from(grid.children) as HTMLElement[];
    const now = new Map<string, { x: number; y: number; order: number; el: HTMLElement }>();
    children.forEach((el, i) => {
      const key = keys[i];
      if (key !== undefined) now.set(key, { x: el.offsetLeft, y: el.offsetTop, order: i, el });
    });

    const before = previous.current;
    previous.current = new Map([...now].map(([k, v]) => [k, { x: v.x, y: v.y, order: v.order }]));
    if (!before || prefersReducedMotion() || typeof grid.animate !== "function") return;

    let added = 0;
    for (const k of now.keys()) if (!before.has(k)) added++;
    let removed = 0;
    for (const k of before.keys()) if (!now.has(k)) removed++;
    let changed = added + removed;
    // Un pur changement d'ordre : les cartes qui ont changé de rang.
    if (changed === 0 && reorders) {
      for (const [k, v] of now) if (before.get(k)?.order !== v.order) changed++;
    }
    if (changed === 0) return;
    const wait = delayMs ? Math.max(0, delayMs()) : 0;
    if (changed > maxChanged) {
      if (fadeBeyond && now.size - added > 0) {
        // `backwards` : la rangée reste effacée pendant l'attente, au lieu de s'afficher puis de
        // s'effacer pour réapparaître.
        grid.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: EASE, delay: wait, fill: "backwards" });
      }
      return;
    }

    const viewTop = -window.innerHeight;
    const viewBottom = window.innerHeight * 2;
    let moving = 0;
    for (const [k, { x, y, el }] of now) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < viewTop || rect.top > viewBottom) continue;
      const from = before.get(k);
      // Chaque carte qui bouge part un peu après la précédente ; `backwards` la tient à son point de
      // départ pendant qu'elle attend.
      const timing: KeyframeAnimationOptions = { duration: MOVE_MS, easing: EASE };
      const delay = wait + moving * staggerMs;
      if (delay > 0) Object.assign(timing, { delay, fill: "backwards" });
      if (!from) {
        el.animate([{ opacity: 0, transform: "scale(0.92)" }, { opacity: 1, transform: "none" }], timing);
        moving++;
        continue;
      }
      const dx = from.x - x;
      const dy = from.y - y;
      if (dx === 0 && dy === 0) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing);
      moving++;
    }
    // `keys` est lu par sa signature : un tableau neuf à chaque rendu ne doit pas relancer ceci.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, gridRef]);
}
