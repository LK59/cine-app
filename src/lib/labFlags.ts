"use client";

import { useSyncExternalStore } from "react";

/**
 * Les essais de fluidité de « Tous les films » (Lab → Tests divers, 13/10/2026).
 *
 * Un à-coup unique quand la rangée des filtres reparaît en remontant la grille, proportionnel au
 * nombre de titres (25 films : rien ; 212 : à peine ; 800 : net), que ni le simulateur WebKit ni deux
 * correctifs n'ont fait disparaître. Trois interrupteurs, chacun retire un suspect, pour que
 * l'iPhone de Louis tranche. Gardés sur l'appareil, sans effet pour qui ne les a pas allumés : à
 * retirer une fois la cause trouvée.
 */
export type LabFlag = "filtersNoScroll" | "noHeaderFade" | "noDecodeAhead";

const PREFIX = "cine:lab:";
const listeners = new Set<() => void>();
let snapshot: Record<LabFlag, boolean> | null = null;

function read(): Record<LabFlag, boolean> {
  if (snapshot) return snapshot;
  const get = (flag: LabFlag) => {
    try {
      return localStorage.getItem(PREFIX + flag) === "1";
    } catch {
      return false;
    }
  };
  snapshot = { filtersNoScroll: get("filtersNoScroll"), noHeaderFade: get("noHeaderFade"), noDecodeAhead: get("noDecodeAhead") };
  return snapshot;
}

const OFF: Record<LabFlag, boolean> = { filtersNoScroll: false, noHeaderFade: false, noDecodeAhead: false };

export function setLabFlag(flag: LabFlag, on: boolean): void {
  try {
    if (on) localStorage.setItem(PREFIX + flag, "1");
    else localStorage.removeItem(PREFIX + flag);
  } catch {
    /* l'essai vaut pour cette page seulement */
  }
  snapshot = { ...read(), [flag]: on };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLabFlags(): Record<LabFlag, boolean> {
  return useSyncExternalStore(subscribe, read, () => OFF);
}
