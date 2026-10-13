"use client";

import { useEffect, type RefObject } from "react";

/** Le rythme et la borne de la recherche du bouton : 250 ms, trente secondes au plus. */
const POLL_MS = 250;
const MAX_ATTEMPTS = 120;

/**
 * Le focus entre dans le lecteur plein écran, sur lecture/pause.
 *
 * L'ordre de tabulation suit le document, pas l'empilement à l'écran : sans cela, le focus reste là
 * où il était sur la page qui a lancé la lecture — le bouton « Lecture » de la fiche, toujours montée
 * sous le lecteur. Tab et Entrée semblaient sans effet, et pire : le clavier du lecteur laisse Entrée
 * au bouton qui a le focus (`PlayerControls`), si bien qu'Entrée — le centre du pavé d'une
 * télécommande — actionnait ce bouton caché sous le film au lieu de mettre en pause.
 *
 * Lecture/pause précisément (`data-player-nav="playpause"`), pas « le premier bouton » : les sauts de
 * dix secondes l'encadrent dans le document. Cherché à intervalles et non une fois : le bouton n'existe
 * qu'après le chargement, et le lecteur natif garde ses commandes `inert` jusqu'à la première image —
 * un `focus()` y est sans effet, d'où la vérification que le focus a bien été pris. Rien n'est volé à
 * qui l'a déjà posé dans le lecteur.
 *
 * Écrit une fois pour les deux lecteurs (chasse aux défauts du 13/10/2026) : seul le lecteur serveur
 * le faisait, et le lecteur natif — celui de presque toutes les séances — laissait le focus sous le film.
 */
export function usePlayerFocus(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      const container = containerRef.current;
      const focused = typeof document === "undefined" ? null : document.activeElement;
      if (container && focused && focused !== document.body && container.contains(focused)) {
        clearInterval(id);
        return;
      }
      const button = container?.querySelector<HTMLElement>('[data-player-nav="playpause"]');
      if (button) {
        button.focus({ preventScroll: true });
        if (document.activeElement === button) {
          clearInterval(id);
          return;
        }
      }
      // Une ouverture qui ne finit jamais (erreur fatale, chargement sans fin) n'a pas de bouton à
      // trouver : la recherche s'arrête d'elle-même.
      if (attempts >= MAX_ATTEMPTS) clearInterval(id);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [containerRef, active]);
}
