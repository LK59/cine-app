"use client";

import { useEffect, type RefObject } from "react";
import { clearSheetTimeout, sheetTimeout } from "./dom";

/** Le temps pendant lequel la fiche qui arrive refuse la suite d'un double-clic. */
export const ENTRY_REPEAT_CLICK_MS = 600;

/**
 * La suite d'un double-clic, tombée dans la fiche qui vient de s'ouvrir : retenue.
 *
 * Double-cliquer une affiche — un réflexe d'ordinateur — ouvrait la fiche au premier clic, et le
 * second atterrissait sur ce qui se trouvait désormais sous la souris : le résumé (sa fenêtre
 * s'ouvrait par-dessus, deux Échap pour revenir), une fois sur huit « À voir », qui ajoutait le
 * titre à la liste (passe de nuit du 15/10/2026, BUREAU-17 / ROBUSTESSE-2). Le second clic d'un
 * double-clic porte `detail ≥ 2` ; un clic simple, si rapide soit-il, porte 1 et passe toujours —
 * « Lire » d'un spectateur pressé n'attend rien. Posé à l'ouverture seulement, et retiré au délai.
 *
 * Dans `useSheetMorph`, que toutes les fiches de titre traversent (directement au téléphone, par
 * `useSheetTransition` au bureau) : une seule pose pour le film, la série et la découverte.
 */
export function useSwallowEntryRepeatClicks(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      if (e.detail < 2) return;
      e.preventDefault();
      e.stopPropagation();
    };
    root.addEventListener("click", onClick, true);
    const timer = sheetTimeout(() => root.removeEventListener("click", onClick, true), ENTRY_REPEAT_CLICK_MS);
    return () => {
      root.removeEventListener("click", onClick, true);
      clearSheetTimeout(timer);
    };
    // Au montage seulement (la référence ne change pas) : c'est l'arrivée de la fiche qui ouvre la
    // fenêtre.
  }, [rootRef]);
}
