"use client";

import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * `false` au rendu serveur et pendant l'hydratation, `true` ensuite — sans effet ni `setState`
 * (la règle `set-state-in-effect` du compilateur React les refuse).
 *
 * Pour ce que le serveur ne peut pas savoir et que le HTML doit pourtant dessiner juste : tant que
 * c'est `false`, le rendu doit être le même des deux côtés, et c'est une marque posée avant le
 * premier dessin (`interfaceDecision.ts`) qui choisit, en CSS, ce qui se voit.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false
  );
}
