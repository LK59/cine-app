"use client";

import { useEffect } from "react";

// TV-remote-style arrow-key navigation across the home page's poster carousels — deliberately
// NOT built as a React-state-tracked cursor (compare useListKeyNav.ts, which drives a single
// linear list via j/k on the radarr/sonarr pages): with several independent rows of cards each
// owned by their own component, tracking "which row/col is focused" as shared state would mean
// threading that state (and a re-render on every arrow press) through every card. Native DOM
// focus already gives all of that for free — the browser tracks "what's focused", moves the
// natural :focus-visible ring with it, and Enter already activates a focused <a>/<button> with
// zero extra code. This hook's only job is deciding which element to move focus TO.
//
// Cards opt in by rendering data-tv-card + data-tv-row (any shared string per row, e.g.
// "resume", "recent-movies") + data-tv-col (its index within that row) on their outer focusable
// element (an <a> or <button> — never a plain <div>, so Enter/click already just works).
function isInputFocused(): boolean {
  const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
  return ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
}

function getRows(): HTMLElement[][] {
  const all = Array.from(document.querySelectorAll<HTMLElement>("[data-tv-card]"));
  const byRow = new Map<string, HTMLElement[]>();
  for (const el of all) {
    const row = el.dataset.tvRow ?? "";
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row)!.push(el);
  }
  for (const cards of byRow.values()) {
    cards.sort((a, b) => Number(a.dataset.tvCol) - Number(b.dataset.tvCol));
  }
  /**
   * Ordonnées par leur position dans le document, et non par une mesure d'écran.
   *
   * Elles l'étaient par `getBoundingClientRect().top`, ce qui suppose que la page soit au repos.
   * Elle ne l'est jamais ici : un changement de rangée lance un défilement doux, la rotation de
   * la rangée « À la une » en lance un autre de son côté, et une touche pressée entre les deux
   * lisait des positions en cours d'animation — d'où un ordre qui n'était pas celui de l'écran,
   * et une flèche qui sautait des rangées entières.
   *
   * L'ordre du document est celui de l'affichage — ces rangées sont empilées en colonne — et il
   * ne dépend d'aucun instant. Une rangée absente ce rendu-là (pas de reprises, par exemple)
   * n'apparaît simplement pas, sans numérotation à tenir.
   */
  return [...byRow.values()].sort((a, b) =>
    a[0].compareDocumentPosition(b[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  );
}

/**
 * Amener une carte sous les yeux — et, quand on change de rangée, la rangée entière.
 *
 * `block: "nearest"` ne déplace rien tant que l'élément est ne serait-ce que partiellement
 * visible : descendre d'une rangée amenait donc la carte suivante juste assez pour toucher le
 * bord bas de l'écran, affiches coupées et intitulé hors champ. Et comme aucun défilement
 * n'avait lieu, l'accrochage n'avait rien à corriger.
 *
 * Un changement de rangée fait donc défiler la *rangée* — son intitulé compris — jusqu'en haut
 * du panneau. Un déplacement à l'intérieur d'une rangée garde le comportement discret : on ne
 * veut pas que chaque flèche gauche/droite fasse sauter la page.
 */
function focusCard(el: HTMLElement, movedRow = false): void {
  // `preventScroll` : le navigateur amène de lui-même un élément focalisé sous les yeux, avec
  // ses propres règles — qui se disputeraient celles d'en dessous.
  el.focus({ preventScroll: true });
  if (movedRow) {
    const row = el.closest<HTMLElement>("[data-tv-rowroot]") ?? el;
    row.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  el.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
}

// `enabled` lets a caller pause the hook without unmounting it (e.g. Cinema Mode's detail
// overlay, which owns its own Up/Down + Escape handling for its vertical menu — leaving this
// hook live at the same time would have it try to move focus across the grid underneath while
// the overlay is open).
export function useTvGridNav(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent) {
      if (isInputFocused()) return;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      // Le rail du lecteur navigue à ses propres flèches. Sans cette garde, une flèche vers le
      // bas depuis « Recherche » sautait dans la grille au lieu de descendre sur « Ma liste » :
      // la branche « rien de focalisé dans la grille » ci-dessous ne distingue pas « nulle part »
      // de « ailleurs, exprès ».
      if ((document.activeElement as HTMLElement | null)?.closest("[data-player-nav]")) return;

      const rows = getRows();
      if (rows.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      const activeRowIdx = active ? rows.findIndex((r) => r.includes(active)) : -1;

      // Nothing focused in the grid yet — Down/Right from wherever the user was jumps straight
      // into the first card, so the very first press already does something useful.
      if (activeRowIdx === -1) {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          focusCard(rows[0][0], true);
        }
        return;
      }

      const row = rows[activeRowIdx];
      const colIdx = row.indexOf(active!);

      if (e.key === "ArrowLeft" && colIdx > 0) {
        e.preventDefault();
        focusCard(row[colIdx - 1]);
      } else if (e.key === "ArrowRight" && colIdx < row.length - 1) {
        e.preventDefault();
        focusCard(row[colIdx + 1]);
      } else if (e.key === "ArrowUp" && activeRowIdx > 0) {
        e.preventDefault();
        const target = rows[activeRowIdx - 1];
        focusCard(target[Math.min(colIdx, target.length - 1)], true);
      } else if (e.key === "ArrowUp" && activeRowIdx === 0) {
        // Top row: nowhere left to go within the grid — hand off to whatever wants to sit
        // above it (Cinema Mode's Films/Séries toggle marks itself with this attribute).
        const escapeTarget = document.querySelector<HTMLElement>("[data-tv-escape-up]");
        if (escapeTarget) {
          e.preventDefault();
          escapeTarget.focus();
        }
      } else if (e.key === "ArrowDown" && activeRowIdx < rows.length - 1) {
        e.preventDefault();
        const target = rows[activeRowIdx + 1];
        focusCard(target[Math.min(colIdx, target.length - 1)], true);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
