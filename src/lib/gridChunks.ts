"use client";

import { useEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

/**
 * La grille complète, découpée en paquets de rangées (13/10/2026).
 *
 * Mesure de Louis sur son iPhone (ligne `fluidite` du 13/10/2026, 8.53.3, « Tous les films »,
 * 800 cartes, trois colonnes) : 978 images en 20 s, 95e centile à 30 ms, mais neuf images de 120 à
 * 133 ms — toutes **en remontant près du haut**, et sept fois sur dix avec un
 * `contentvisibilityautostatechange` « mise de côté » de trois cartes (une rangée) dans la même
 * image ou juste avant. Chaque carte portait `content-visibility: auto`, mais les huit cents étaient
 * les enfants d'**une seule** grille CSS : qu'une rangée passe de sautée à rendue (ou l'inverse), et
 * le navigateur refaisait la mise en page de toute la grille — l'algorithme des pistes sur huit cents
 * éléments. Un coût proportionnel au nombre de titres (25 : rien ; 212 : à peine ; 800 : ~120 ms),
 * et indépendant de la vitesse du geste.
 *
 * Chaque paquet est donc sa propre grille, et c'est lui — non la carte — qui porte
 * `content-visibility: auto` : un paquet qui change d'état ne relance que la mise en page d'une
 * colonne de paquets (une trentaine) et la sienne (ses `ROWS_PER_CHUNK` rangées).
 *
 * **Un paquet tient toujours un nombre entier de rangées** : sinon sa dernière rangée, incomplète,
 * laisserait un trou *au milieu* de la liste. Le nombre de colonnes n'est donc plus laissé à la
 * feuille de style (au-delà de 1 280 px, `auto-fill` en logeait autant que la largeur le permet, sept
 * à onze, qu'aucun multiple commun raisonnable ne couvre) : il est calculé ici, par la même règle
 * qu'elle, et posé sur chaque paquet. Les paquets et leurs colonnes viennent du même nombre, ils ne
 * peuvent pas se contredire.
 */

/** Marque un paquet : les crochets qui cherchent les cartes descendent d'un niveau en le voyant. */
export const GRID_CHUNK_ATTR = "data-grid-chunk";

/**
 * Huit rangées par paquet : 24 cartes sur un téléphone, 48 à 88 sur un grand écran. Assez peu pour
 * qu'un paquet qui entre dans le champ se mette en page vite, assez pour qu'une liste de huit cents
 * n'en fasse qu'une trentaine.
 */
export const ROWS_PER_CHUNK = 8;

/** L'écart entre deux colonnes, `gap-x-3` : 0,75 rem. */
const GAP_X_REM = 0.75;
/** La largeur minimale d'une colonne au-delà de 1 280 px, celle de `player-grid-fluid` : 9,5 rem. */
const FLUID_MIN_REM = 9.5;

/**
 * Le nombre de colonnes que la grille aurait — la même règle que `grid-cols-3 sm:grid-cols-4
 * md:grid-cols-5 lg:grid-cols-6 player-grid-fluid`. Les paliers suivent la largeur de la fenêtre
 * (des requêtes média) ; au-delà de 1 280 px, la largeur de la grille elle-même, comme `auto-fill`.
 */
export function gridColumnsFor(viewportWidth: number, gridWidth: number, remPx = 16): number {
  if (viewportWidth < 640) return 3;
  if (viewportWidth < 768) return 4;
  if (viewportWidth < 1024) return 5;
  if (viewportWidth < 1280) return 6;
  const gap = GAP_X_REM * remPx;
  // `auto-fill` : autant de pistes de 9,5 rem que la largeur en loge, écarts compris. Un millième
  // de pixel de tolérance pour ne pas perdre une colonne sur un arrondi de largeur fractionnaire.
  return Math.max(1, Math.floor((gridWidth + gap + 0.001) / (FLUID_MIN_REM * remPx + gap)));
}

/** La liste coupée en paquets de `columns × ROWS_PER_CHUNK` — un multiple exact des colonnes. */
export function chunkList<T>(items: readonly T[], columns: number): T[][] {
  const size = Math.max(1, columns) * ROWS_PER_CHUNK;
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Les cartes d'une grille, dans l'ordre : les enfants de ses paquets si elle en a, ses propres
 * enfants sinon. `useDecodeAhead` et `useMeasuredCardHeight` lisaient `root.children` — les paquets,
 * désormais.
 */
export function gridCards(root: Element): Element[] {
  const cards: Element[] = [];
  for (const child of root.children) {
    if (child.hasAttribute(GRID_CHUNK_ATTR)) cards.push(...child.children);
    else cards.push(child);
  }
  return cards;
}

/** Le nombre de colonnes d'un paquet, écrit dans sa marque (`data-grid-chunk="3"`). */
function chunkColumns(chunk: Element): number {
  return Math.max(1, Number(chunk.getAttribute(GRID_CHUNK_ATTR)) || 1);
}

/**
 * Les rangées d'un paquet que recouvre un rectangle — la marge de l'observateur, pour le décodage
 * anticipé : `[première, après la dernière[`. Les rangées d'un paquet sont toutes de la même hauteur
 * (cartes `uniform`), et le paquet garde sa boîte même sauté : la proportion suffit.
 */
export function chunkRowsIn(
  chunk: Element,
  box: { top: number; height: number },
  hit: { top: number; bottom: number }
): [number, number] {
  const rowCount = Math.ceil(chunk.children.length / chunkColumns(chunk));
  if (!(box.height > 0) || rowCount === 0) return [0, rowCount];
  const rowHeight = box.height / rowCount;
  const clamp = (n: number) => Math.min(rowCount, Math.max(0, n));
  const from = clamp(Math.floor((hit.top - box.top) / rowHeight));
  const to = clamp(Math.ceil((hit.bottom - box.top) / rowHeight));
  return [from, Math.max(from, to)];
}

/** Les cartes des rangées `[from, to[` d'un paquet. */
export function chunkCardsOf(chunk: Element, [from, to]: [number, number]): Element[] {
  const columns = chunkColumns(chunk);
  return Array.from(chunk.children).slice(from * columns, to * columns);
}

/** La première carte, sans parcourir les huit cents. */
export function firstGridCard(root: Element): Element | null {
  const first = root.firstElementChild;
  if (first?.hasAttribute(GRID_CHUNK_ATTR)) return first.firstElementChild;
  return first;
}

function viewportWidth(): number {
  // La largeur que voient les requêtes média (barre de défilement comprise) : `innerWidth`.
  return typeof window === "undefined" ? 390 : window.innerWidth;
}

function remPx(): number {
  if (typeof document === "undefined") return 16;
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * Les colonnes de la grille, suivies : la largeur de la grille (un `ResizeObserver`, qui rend aussi
 * une première mesure dès qu'il observe) et les paliers de la fenêtre. Avant la première mesure, une
 * estimation d'après la fenêtre — exacte sous 1 280 px, corrigée avant la première image au-delà
 * (`flushSync` : sinon une image partait avec des paquets coupés au mauvais endroit).
 */
export function useGridColumns(grid: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(() => gridColumnsFor(viewportWidth(), Math.min(viewportWidth(), 1920)));
  useEffect(() => {
    const root = grid.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = gridColumnsFor(viewportWidth(), root.clientWidth, remPx());
      if (next > 0) flushSync(() => setColumns((prev) => (prev === next ? prev : next)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    // Un palier franchi sans que la grille change de largeur (le rail qui se replie au même
    // moment) : la largeur seule ne le dirait pas.
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [grid]);
  return columns;
}
