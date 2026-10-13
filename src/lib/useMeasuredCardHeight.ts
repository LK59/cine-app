"use client";

import { useEffect, type RefObject } from "react";

/**
 * La hauteur supposée des cartes d'une grille, prise sur une vraie carte (13/10/2026).
 *
 * Chaque carte de `.player-grid` porte `content-visibility: auto` : tant qu'elle n'a jamais été
 * mise en page, elle compte pour la hauteur écrite dans la feuille de style (228 px sur
 * téléphone). Or une carte réelle en mesurait 206 (titre sur une ligne) ou 223 (sur deux) —
 * jamais 228. Une rangée jamais rendue se tasse donc de 5 ou 22 px **à l'instant où elle entre
 * dans le champ**, et WebKit n'a pas d'ancrage du défilement : tout ce qui est dessous saute
 * d'autant, sous le doigt.
 *
 * Pourquoi « Tous les films » et jamais « Toutes les séries » : une rangée n'est jamais rendue
 * quand le défilement la traverse pendant que le fil principal est pris. À l'ouverture, la grille
 * construit la liste entière derrière son premier écran (`useDeferredValue`) — huit cents cartes,
 * de 64 à 382 ms dans le banc, contre 11 à 29 ms pour cent soixante-dix séries. Un lancer donné
 * à ce moment-là passe sur les rangées 3 à 16 sans qu'aucune ne soit mise en page ; en remontant,
 * elles se tassent l'une après l'autre jusqu'au premier écran — là où la rangée des filtres va
 * reparaître.
 *
 * Mesuré (Playwright WebKit, 390 × 844, lancer de 6 000 px à l'horloge comme le défilement
 * asynchrone d'iOS, puis remontée à 0,2 px/ms, trois passages chacun) :
 *   films, avant  : 4 à 14 rangées jamais rendues → 4 à 14 sauts de 5 ou 22 px en remontant
 *   séries, avant : 0 rangée jamais rendue        → 0 saut
 *   films, après  : 4 à 16 rangées jamais rendues → 0 saut (cartes de 224,75 px, supposées 224,75)
 *
 * Le remède a deux moitiés : des cartes toutes de la même hauteur (`uniform` sur
 * `PlayerResultCard` — deux lignes de titre et la ligne de l'année toujours réservées), et cette
 * hauteur-là, mesurée, comme taille supposée (`data-card-h` / `--card-h`, globals.css). Une
 * constante ne pouvait pas suffire : la hauteur suit la largeur des colonnes, donc l'écran.
 */
export function useMeasuredCardHeight(grid: RefObject<HTMLElement | null>, items: unknown): void {
  useEffect(() => {
    const root = grid.current;
    const first = root?.firstElementChild;
    if (!root || !(first instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // Une carte sautée (hors du champ) mesure ce qu'on lui suppose : la relire n'apprendrait rien,
      // et figerait une valeur périmée après une rotation faite loin du haut.
      if (first.checkVisibility?.({ contentVisibilityAuto: true }) === false) return;
      const style = getComputedStyle(first);
      // La boîte de contenu, celle que `contain-intrinsic-size` décrit : sans la marge intérieure
      // que `grid-hover-zoom` ajoute au pointeur fin (et retire aussitôt par une marge négative).
      const height =
        first.getBoundingClientRect().height -
        (parseFloat(style.paddingTop) || 0) -
        (parseFloat(style.paddingBottom) || 0) -
        (parseFloat(style.borderTopWidth) || 0) -
        (parseFloat(style.borderBottomWidth) || 0);
      if (!(height > 0)) return;
      root.style.setProperty("--card-h", `${height}px`);
      root.setAttribute("data-card-h", "");
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(first);
    return () => observer.disconnect();
  }, [grid, items]);
}
