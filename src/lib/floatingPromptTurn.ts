"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Une invitation flottante à la fois (DECISIONS.md §119).
 *
 * Plusieurs bannières se posent au même endroit, au bas de l'écran ou par-dessus : l'aide
 * d'installation, la fenêtre des Nouveautés, l'invitation aux notifications, celle de retélécharger
 * après un passage. Juste après un passage, elles se présentaient toutes au même lancement, l'une sur
 * l'autre. Chacune dit ici qu'elle veut paraître, avec son rang : la plus petite passe, et à rang
 * égal la première arrivée ; les autres attendent qu'elle s'en aille. Le rang 0 (l'aide
 * d'installation, les Nouveautés) ne cède jamais — ce sont des étapes, pas des invitations.
 */
export const PROMPT_RANK = {
  /** L'aide d'installation, la fenêtre des Nouveautés : jamais retenues. */
  step: 0,
  /** L'invitation aux notifications (`PushResumePrompt`). */
  push: 1,
  /** Après un passage : retélécharger, ou « effacés de l'ancienne adresse ». */
  passage: 2,
} as const;

interface Want {
  rank: number;
  since: number;
}

const wants = new Map<string, Want>();
const listeners = new Set<() => void>();
let counter = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Vrai si `id` passe : aucune autre qui la précède (rang plus petit, ou même rang arrivée avant). */
function holds(id: string): boolean {
  const mine = wants.get(id);
  if (!mine) return false;
  for (const [other, want] of wants) {
    if (other === id) continue;
    if (want.rank < mine.rank || (want.rank === mine.rank && want.since < mine.since)) return false;
  }
  return true;
}

/**
 * `wanted` : l'invitation voudrait paraître. Rend vrai quand c'est son tour. Une invitation retirée
 * (`wanted` faux, ou démontée) rend la place aussitôt.
 */
export function useFloatingPromptTurn(id: string, rank: number, wanted: boolean): boolean {
  useEffect(() => {
    if (!wanted) return;
    wants.set(id, { rank, since: ++counter });
    emit();
    return () => {
      wants.delete(id);
      emit();
    };
  }, [id, rank, wanted]);
  return useSyncExternalStore(
    subscribe,
    // Une étape paraît dès son premier rendu : elle s'annonce, elle n'attend pas.
    () => wanted && (rank === PROMPT_RANK.step || holds(id)),
    () => false
  );
}

/** Pour les tests : aucune invitation en attente. */
export function resetFloatingPrompts(): void {
  wants.clear();
  emit();
}
