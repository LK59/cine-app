"use client";

import { useEffect, useRef } from "react";

/**
 * Les touches d'une fiche de titre : Échap et Retour arrière la referment, le reste passe à son
 * menu (DECISIONS.md §117).
 *
 * Chaque fiche avait son écouteur, et chacun sa liste de silences : des drapeaux locaux (bande-annonce,
 * synopsis, épisodes), une requête sur `[data-action-sheet]` pour deux d'entre elles, rien pour les
 * fiches du bureau — dont Retour arrière dans le champ de la fenêtre « Partager » refermait la fiche,
 * et dont Échap fermait la fenêtre *et* la fiche (audit du 23/10/2026). La fiche du téléphone, elle,
 * ne fermait que sur Échap. Une seule règle ici, que toutes appellent.
 */

/** Un champ où Retour arrière efface : la touche lui appartient. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
}

/**
 * Cette touche est-elle pour quelqu'un d'autre que la fiche ?
 *
 *  * une feuille (`ActionSheet`) est ouverte par-dessus : elle a ses touches — Échap la referme,
 *    elle, et les flèches parcourent ses choix (règle 2 des fiches : un écran recouvert n'a pas
 *    d'avis). `ActionSheet` arrête déjà ces touches en capture ; ceci couvre les écouteurs posés en
 *    capture avant elle (`useSheetExit`) et les 300 ms de sa sortie ;
 *  * Retour arrière dans un champ de saisie efface une lettre.
 */
export function sheetKeyBelongsElsewhere(e: KeyboardEvent): boolean {
  if (typeof document !== "undefined" && document.querySelector("[data-action-sheet]")) return true;
  return e.key === "Backspace" && isEditable(e.target);
}

/** Les deux touches qui referment une fiche. */
export const isSheetCloseKey = (e: KeyboardEvent) => e.key === "Escape" || e.key === "Backspace";

/**
 * L'écouteur d'une fiche, posé sur `window` tant qu'elle écoute (`listening` : ni recouverte, ni sous
 * le lecteur, ni sous une fenêtre à elle). Échap et Retour arrière appellent `onClose`, toute autre
 * touche `onKey` (les flèches du menu). Les deux sont relus à l'appel : l'écouteur n'est reposé que
 * quand `listening` change.
 */
export function useSheetKeys({
  listening,
  onClose,
  onKey,
}: {
  listening: boolean;
  onClose: () => void;
  onKey?: (e: KeyboardEvent) => void;
}): void {
  const handlers = useRef({ onClose, onKey });
  useEffect(() => {
    handlers.current = { onClose, onKey };
  }, [onClose, onKey]);

  useEffect(() => {
    if (!listening) return;
    function onKeyDown(e: KeyboardEvent) {
      if (sheetKeyBelongsElsewhere(e)) return;
      if (isSheetCloseKey(e)) {
        e.preventDefault();
        handlers.current.onClose();
        return;
      }
      handlers.current.onKey?.(e);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [listening]);
}
