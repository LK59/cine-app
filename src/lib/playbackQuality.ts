"use client";

import { useSyncExternalStore } from "react";
import { persistedCacheAccount } from "@/lib/persistentCache";
import type { LighterStep } from "@/lib/slowLinkPolicy";

/**
 * Le réglage « Qualité » du lecteur (menu ⋮, DECISIONS.md §78) : **Automatique** (par défaut) — sur une
 * connexion trop lente, le lecteur passe de lui-même à la vidéo allégée — ou **Originale** — jamais :
 * seulement l'indice « Connexion lente… » et, au renoncement, l'écran final. Pas de « vidéo allégée » à
 * la demande.
 *
 * Par compte et par appareil, comme les autres réglages du lecteur gardés sur l'appareil (sous-titres,
 * dialogues, plafond HDR) : la clé porte le compte, pour qu'un iPad partagé garde le choix de chacun.
 * Un stockage qui refuse vaut « Automatique ».
 *
 * Gardé en mémoire une fois lu : `usePlaybackQuality` le relit à chaque rendu des deux lecteurs, et
 * `localStorage` est synchrone. Seul `writePlaybackQuality` le change (ou un autre compte).
 */
export type PlaybackQuality = "auto" | "original";

const PREFIX = "cine:quality:";
const listeners = new Set<() => void>();
let cached: { key: string; value: PlaybackQuality } | null = null;

function account(): string {
  return persistedCacheAccount() ?? "";
}

function key(): string {
  return PREFIX + account();
}

export function readPlaybackQuality(): PlaybackQuality {
  const k = key();
  if (cached?.key === k) return cached.value;
  let value: PlaybackQuality = "auto";
  try {
    value = localStorage.getItem(k) === "original" ? "original" : "auto";
  } catch {
    value = "auto";
  }
  cached = { key: k, value };
  return value;
}

export function writePlaybackQuality(quality: PlaybackQuality): void {
  cached = { key: key(), value: quality };
  try {
    if (quality === "auto") localStorage.removeItem(key());
    else localStorage.setItem(key(), quality);
  } catch {
    /* la séance garde le réglage, la suivante repartira en « Automatique » */
  }
  // « Originale » : plus jamais de version allégée, l'héritée comprise.
  if (quality === "original") forgetLighterCarry();
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

// --- la règle des deux minutes ------------------------------------------------------------------

/**
 * La seule mémoire de la version allégée (§78). Une lecture lancée moins de deux minutes après une
 * séance passée en version allégée — quel que soit le titre — démarre directement en allégée, au
 * dernier palier (Louis, 12/10/2026) : en deux minutes la connexion n'a pas changé, et la reprendre
 * au lecteur natif referait attendre trente-cinq secondes pour rien. Au-delà, ou sans séance allégée
 * récente, la lecture repart normalement.
 *
 * Ce n'est pas un apprentissage par appareil (écarté par Louis) : la mémoire vit deux minutes, dans
 * la page et dans `sessionStorage` (elle survit au rechargement WebKit d'un changement de piste,
 * jamais à la fermeture de l'onglet), et rien n'est écrit pour durer. Elle porte le compte : un
 * appareil partagé ne passe pas le palier de l'un à l'autre. Effacée par « Originale », et par le
 * lien rétabli (`LinkRecovery`) ; jamais lue ni écrite hors « Automatique ».
 */
export const LIGHTER_CARRY_MS = 2 * 60_000;
const CARRY_KEY = "cine:lighter-carry";
type Carry = LighterStep & { at: number; account: string };
let carry: Carry | null = null;

/** Une séance allégée s'arrête (fermée, épisode suivant, page quittée) : retenue deux minutes. */
export function rememberLighter(step: LighterStep, now = Date.now()): void {
  if (readPlaybackQuality() !== "auto") return;
  carry = { targetBps: step.targetBps, tier: step.tier, at: now, account: account() };
  try {
    sessionStorage.setItem(CARRY_KEY, JSON.stringify(carry));
  } catch {
    /* la mémoire de la page suffit */
  }
}

/** Le palier à reprendre pour une lecture qui commence maintenant, ou `null`. */
export function carriedLighter(now = Date.now()): LighterStep | null {
  if (readPlaybackQuality() !== "auto") return null;
  let known = carry;
  if (!known) {
    try {
      const raw = JSON.parse(sessionStorage.getItem(CARRY_KEY) ?? "null") as Carry | null;
      if (raw && typeof raw.targetBps === "number" && typeof raw.tier === "number" && typeof raw.at === "number") known = raw;
    } catch {
      known = null;
    }
  }
  if (!known || known.account !== account() || now - known.at > LIGHTER_CARRY_MS || now < known.at) return null;
  return { targetBps: known.targetBps, tier: known.tier };
}

/** Oublier la séance allégée : « Originale », ou le lien a retrouvé de quoi porter la lecture classique. */
export function forgetLighterCarry(): void {
  carry = null;
  try {
    sessionStorage.removeItem(CARRY_KEY);
  } catch {
    /* rien */
  }
}
