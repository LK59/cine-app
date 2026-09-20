"use client";

import { useEffect, type RefObject } from "react";

/**
 * L'équivalent tactile du survol : la carte qui s'arrête au milieu prend la bannière.
 *
 * Au pointeur, la bannière du mode cinéma suit la carte sous le curseur — c'est ce qui rend la
 * moitié haute de l'écran vivante. Au doigt il n'y a pas de curseur, et sur une tablette cette
 * moitié d'écran était donc entièrement passive : elle tournait toute seule et rien de ce qu'on
 * faisait ne pouvait l'influencer. Signalé le 20/09/2026 — « j'ai la moitié de l'écran qui affiche
 * un truc qui correspond pas à ce que je veux car je navigue dans les rangées avec le doigt ».
 *
 * Le geste existait déjà : on fait glisser une rangée, on descend d'une rangée. Ce qui manquait,
 * c'est de l'écouter.
 *
 * **Un seul écouteur pour toutes les rangées**, posé sur le panneau qui les contient et non sur
 * chacune. Il y en a quatre sortes — films, séries, top 10, découverte — et les câbler une à une
 * aurait été la quatrième copie d'une même décision, exactement ce que ce dépôt paie cher ailleurs.
 * Un événement `scroll` ne remonte pas, mais il *descend* : un écouteur en capture les reçoit tous.
 *
 * **Et rien de neuf à brancher derrière.** Les cartes portent déjà `onFocus`, parce que la
 * navigation à la télécommande passe par le focus natif du navigateur (voir `useTvGridNav`) ; poser
 * le focus sur la carte centrale emprunte donc le chemin qui existe, jusqu'à la bannière. Sans
 * anneau de focus visible : `:focus-visible` ne s'allume pas pour un focus donné après un geste
 * tactile, et `preventScroll` empêche le navigateur de recentrer ce qu'on vient de placer.
 *
 * Trois précautions, chacune pour un défaut qu'on aurait sinon :
 *
 *  * **après l'arrêt, jamais pendant** — sinon la bannière traverserait dix films en un seul
 *    geste, ce qui serait pire que de ne pas bouger du tout ;
 *  * **passif, et rien de plus qu'une lecture de position une fois le doigt parti** — un
 *    défilement est le moment où le navigateur a le moins de temps à donner ;
 *  * **seulement là où il n'y a pas de survol**, sinon il se disputerait la bannière avec la
 *    souris — deux sources pour une même décision.
 */
const SETTLE_MS = 180;

/** La carte la plus proche du centre horizontal de sa propre rangée. */
function centredCard(row: HTMLElement): HTMLElement | null {
  const middle = row.scrollLeft + row.clientWidth / 2;
  let best: { card: HTMLElement; distance: number } | null = null;
  for (const card of row.querySelectorAll<HTMLElement>("[data-tv-card]")) {
    const distance = Math.abs(card.offsetLeft + card.offsetWidth / 2 - middle);
    if (!best || distance < best.distance) best = { card, distance };
  }
  return best?.card ?? null;
}

/**
 * La rangée au repos après un défilement vertical.
 *
 * Le panneau est en `snap-y mandatory` : à l'arrêt, une rangée a son intitulé collé en haut. C'est
 * celle-là qu'on regarde, donc la première dont le haut n'est plus au-dessus du bord.
 */
function settledRow(pane: HTMLElement): HTMLElement | null {
  const top = pane.getBoundingClientRect().top;
  for (const root of pane.querySelectorAll<HTMLElement>("[data-tv-rowroot]")) {
    if (root.getBoundingClientRect().bottom > top + 8) {
      return root.querySelector<HTMLElement>("[data-tv-card]")?.parentElement ?? null;
    }
  }
  return null;
}

export function useCentredCard(pane: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const element = pane.current;
    if (!element || !enabled) return;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (target: HTMLElement) => {
      // Le panneau lui-même a défilé : c'est un changement de rangée, pas de carte.
      const row = target === element ? settledRow(element) : target;
      if (!row || !element.contains(row)) return;
      centredCard(row)?.focus({ preventScroll: true });
    };

    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => settle(target), SETTLE_MS);
    };

    element.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      element.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [pane, enabled]);
}
