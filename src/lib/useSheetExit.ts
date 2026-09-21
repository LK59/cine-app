"use client";

import { useCallback, useEffect, type CSSProperties } from "react";

/**
 * La sortie d'une fiche que la coquille garde montée pendant son animation — fiche personne,
 * fiche découverte.
 *
 * Ces deux fiches ferment tout de suite (`cinemaClose`), et c'est la coquille qui les garde à
 * l'écran 280 ms de plus en leur passant `leaving` (voir `sheetExitMs` dans PlayerShell). Elles
 * restaient pourtant vivantes pendant ces 280 ms : Échap écouté, voile, croix et poignée sous le
 * doigt. La garde de `cinemaClose` ne tient que jusqu'au `popstate` du premier retour — donc un
 * second appui, ou un second Échap, pendant la sortie reculait d'un cran de plus et refermait
 * aussi la fiche *dessous*, celle qu'on venait de retrouver. C'est la règle 2 de « The sheet
 * lifecycle » (CLAUDE.md) — un écran qui s'en va n'a plus d'avis — que PlayerPanelFrame tenait
 * déjà et que ces deux fiches avaient oubliée, chacune de son côté.
 *
 * Trois choses, et une seule source pour les trois :
 *  * `requestClose` ne fait plus rien une fois la sortie commencée — le geste de glisser, qui
 *    appelle la fermeture de lui-même, compris ;
 *  * Échap et Retour arrière ne sont plus écoutés — pas seulement ignorés : un écouteur qui
 *    avalerait encore la touche la volerait à l'écran qui réapparaît ;
 *  * `style` coupe les pointeurs, à poser sur la racine de la fiche.
 *
 * `listening` dit si la fiche écoute le clavier en dehors de toute sortie : une fiche du dessous,
 * ou une fiche qui a ouvert sa propre fenêtre par-dessus (visionneuse, synopsis), se tait.
 */
export function useSheetExit(
  close: () => void,
  { leaving, listening = true }: { leaving: boolean; listening?: boolean }
): { requestClose: () => void; style: CSSProperties } {
  const requestClose = useCallback(() => {
    if (leaving) return;
    close();
  }, [leaving, close]);

  useEffect(() => {
    if (leaving || !listening) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leaving, listening, close]);

  return { requestClose, style: leaving ? { pointerEvents: "none" } : {} };
}
