"use client";

import { useSyncExternalStore } from "react";
import { persistedCacheAccount } from "@/lib/persistentCache";

/**
 * Le réglage « Qualité » du lecteur (menu ⋮, DECISIONS.md §78) : **Automatique** (par défaut) — sur une
 * connexion trop lente, le lecteur passe de lui-même à la vidéo allégée — ou **Originale** — jamais :
 * seulement l'indice « Connexion lente… » et, au renoncement, l'écran final. Pas de « vidéo allégée » à
 * la demande.
 *
 * Par compte et par appareil, comme les autres réglages du lecteur gardés sur l'appareil (sous-titres,
 * dialogues, plafond HDR) : la clé porte le compte, pour qu'un iPad partagé garde le choix de chacun.
 * Un stockage qui refuse vaut « Automatique ».
 */
export type PlaybackQuality = "auto" | "original";

const PREFIX = "cine:quality:";
const listeners = new Set<() => void>();

function key(): string {
  return PREFIX + (persistedCacheAccount() ?? "");
}

export function readPlaybackQuality(): PlaybackQuality {
  try {
    return localStorage.getItem(key()) === "original" ? "original" : "auto";
  } catch {
    return "auto";
  }
}

export function writePlaybackQuality(quality: PlaybackQuality): void {
  try {
    if (quality === "auto") localStorage.removeItem(key());
    else localStorage.setItem(key(), quality);
  } catch {
    /* la séance garde le réglage, la suivante repartira en « Automatique » */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Le réglage, suivi : un changement depuis le menu se lit aussitôt dans les deux lecteurs. */
export function usePlaybackQuality(): PlaybackQuality {
  return useSyncExternalStore(subscribe, readPlaybackQuality, () => "auto");
}
