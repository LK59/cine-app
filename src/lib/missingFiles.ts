"use client";

import { useSyncExternalStore } from "react";
import { FILE_MISSING } from "@/lib/http";

/**
 * Les titres dont Jellyfin a répondu que le fichier n'existe plus — le seul cas où une fiche grise
 * son bouton Lire.
 *
 * La fiche prépare ce que « Lire » va demander dès qu'elle s'ouvre (`usePlaybackPrefetch`). Si
 * cette demande revient avec `file_missing` — Jellyfin a répondu, et il n'a pas de fichier —, le
 * titre est noté ici et le bouton passe grisé : il ne mènerait qu'à un écran d'erreur (on a déjà vu
 * un titre dont le chemin était périmé). Tout le reste — un réseau coupé, un Jellyfin absent, un
 * jeton refusé, un simple retard — laisse le bouton tel quel : un film lisible ne doit jamais
 * paraître cassé parce qu'une réponse tarde. Le bouton est actif d'emblée, et ne se grise
 * qu'après coup, sur ce seul motif.
 *
 * En mémoire, pour la séance : une réponse réussie plus tard (le fichier a été rétabli) efface la
 * marque.
 */
const missing = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Ce que signifie une erreur de préchargement : le fichier n'existe plus, ou autre chose. */
export function isFileMissing(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === FILE_MISSING;
}

export function markFileMissing(itemId: string): void {
  if (missing.has(itemId)) return;
  missing.add(itemId);
  notify();
}

export function clearFileMissing(itemId: string): void {
  if (!missing.delete(itemId)) return;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Le fichier de ce titre est-il connu pour manquer ? `false` tant qu'on ne sait rien. */
export function useFileMissing(itemId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (itemId ? missing.has(itemId) : false),
    () => false
  );
}
