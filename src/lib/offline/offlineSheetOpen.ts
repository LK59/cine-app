"use client";

import { useSyncExternalStore } from "react";

/**
 * Une fiche hors ligne ouverte (`OfflineTitleSheet`) : elle n'est pas dans l'adresse, et la barre du
 * bas du téléphone (`PlayerBottomBar`), qui s'efface sous les fiches d'après l'adresse, flottait
 * par-dessus elle (relecture du design hors ligne, 19/10/2026). Elle lit donc aussi ceci.
 */
let open = 0;
const listeners = new Set<() => void>();

export function setOfflineSheetOpen(on: boolean): void {
  open = Math.max(0, open + (on ? 1 : -1));
  for (const listener of listeners) listener();
}

export function useOfflineSheetOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open > 0,
    () => false
  );
}
