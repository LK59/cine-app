"use client";

import { useEffect, useRef } from "react";
import { withoutPlayerEntry } from "@/lib/playerHistory";

/**
 * La fiche hors ligne a son entrée d'historique : Retour la ferme (Louis, 19/10/2026 — le bouton
 * Retour d'Android et le geste du navigateur fermaient toute la page des téléchargements, fiche
 * comprise).
 *
 * Le même mécanisme que le lecteur (`playerHistory.ts`) : la fiche n'est pas dans l'adresse (elle vit
 * aussi sur `/hors-ligne`, hors du cinéma), donc une entrée est empilée à son ouverture — même adresse,
 * `history.state` recopié (le cinéma y lit ses clés) plus un jeton à nous. Retour la quitte, et
 * `popstate` ferme la fiche ; la croix, Échap ou le glissement la rendent (`history.back()` reconnu
 * comme le nôtre). Le lecteur ouvert depuis la fiche empile la sienne par-dessus, en recopiant l'état
 * — jeton de la fiche compris : son Retour ramène à la fiche, le suivant à la page.
 */
const KEY = "cineOfflineSheet";
const PAGE = Math.random().toString(36).slice(2, 10);
let seq = 0;
let live: string | null = null;
let consuming = 0;
let consumeTimer: ReturnType<typeof setTimeout> | null = null;
let onConsumed: (() => void) | null = null;
let closer: (() => void) | null = null;

function stateOf(): Record<string, unknown> {
  const s = window.history.state;
  return s && typeof s === "object" ? (s as Record<string, unknown>) : {};
}

function settle() {
  consuming = 0;
  if (consumeTimer) clearTimeout(consumeTimer);
  consumeTimer = null;
  const done = onConsumed;
  onConsumed = null;
  done?.();
}

function onPopState() {
  if (consuming > 0) {
    settle();
    return;
  }
  const here = stateOf()[KEY];
  if (live !== null && here !== live) {
    live = null;
    closer?.();
    return;
  }
  // Une entrée de fiche sans fiche (une page rechargée, un Suivant du navigateur) : le jeton est
  // effacé, l'entrée reste une entrée ordinaire de la page.
  if (live === null && typeof here === "string") {
    const copy = { ...stateOf() };
    delete copy[KEY];
    window.history.replaceState(copy, "", window.location.href);
  }
}

if (typeof window !== "undefined") window.addEventListener("popstate", onPopState);

function hold(): void {
  try {
    const token = `${PAGE}:${++seq}`;
    window.history.pushState({ ...withoutPlayerEntry(stateOf()), [KEY]: token }, "", window.location.href);
    live = token;
  } catch {
    live = null;
  }
}

/** L'entrée est rendue si elle est encore au-dessus ; la promesse se résout une fois le retour fait. */
export function releaseOfflineSheetEntry(): Promise<void> {
  if (typeof window === "undefined" || live === null) return Promise.resolve();
  const token = live;
  live = null;
  if (stateOf()[KEY] !== token) return Promise.resolve();
  return new Promise<void>((resolve) => {
    consuming = 1;
    onConsumed = resolve;
    // Une ceinture : `popstate` suit toujours un `back()` qui avait quelque chose derrière lui.
    consumeTimer = setTimeout(settle, 600);
    try {
      window.history.back();
    } catch {
      settle();
    }
  });
}

/**
 * Branché par la fiche : une entrée tant qu'elle est ouverte (pas pendant sa sortie), et Retour
 * appelle `close` — la même fermeture que sa croix.
 */
export function useOfflineSheetBack(close: () => void, leaving: boolean): void {
  const ref = useRef(close);
  useEffect(() => {
    ref.current = close;
  }, [close]);
  useEffect(() => {
    if (leaving) return;
    hold();
    closer = () => ref.current();
    return () => {
      closer = null;
      void releaseOfflineSheetEntry();
    };
  }, [leaving]);
}

/** Pour les tests. */
export function __resetOfflineSheetHistory(): void {
  live = null;
  closer = null;
  settle();
}
