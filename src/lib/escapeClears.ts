import type { KeyboardEvent } from "react";

/**
 * Échap vide le champ de recherche d'un panneau avant de fermer quoi que ce soit (08/10/2026).
 *
 * Le cadre des panneaux (`PlayerPanelFrame`) laisse passer Échap tant qu'un champ est rempli ; c'est
 * au champ de se vider. Safari et Chrome le font d'eux-mêmes pour un `type="search"`, Firefox non —
 * d'où ce gestionnaire commun aux trois champs (grille complète, Recherche, Ma liste).
 */
export function escapeClears(value: string, clear: () => void) {
  return (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape" || value === "") return;
    e.preventDefault();
    clear();
  };
}
