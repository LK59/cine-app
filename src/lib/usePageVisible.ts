"use client";

import { useSyncExternalStore } from "react";

/**
 * La page est-elle à l'écran ? (08/10/2026)
 *
 * Les bannières tournaient toutes les huit secondes dans un onglet caché, et décodaient d'avance
 * les visuels suivants pour personne : un onglet du bureau laissé ouvert une journée faisait
 * dix mille rotations. Une seule source pour les trois bannières, abonnée à `visibilitychange`.
 * Visible hors du navigateur (rendu serveur).
 */
function subscribe(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function visibleNow(): boolean {
  return document.visibilityState !== "hidden";
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, visibleNow, () => true);
}
