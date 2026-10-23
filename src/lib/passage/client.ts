"use client";

import { readPassageSettings, type PassageSettings } from "./settings";
import { persistedCacheAccount } from "@/lib/persistentCache";

/**
 * Le passage d'adresse côté navigateur (DECISIONS.md §119) — ce que l'ancienne adresse rassemble, et
 * ce que la nouvelle se rappelle entre deux pages.
 */

/** Le jour local où le bandeau a été refermé sur cet appareil (par adresse — `localStorage` l'est). */
export const PASSAGE_BANNER_CLOSED_KEY = "cine:passage-banner-closed";
/** Les réglages arrivés déjà posés sur ce stockage : la date de l'arrivée (`passageArrival`). */
export const PASSAGE_APPLIED_KEY = "cine:passage-applied";
/** Arrivé par le passage dans cet onglet : l'aide « Ajouter à l'écran d'accueil » se montre aussitôt. */
export const PASSAGE_INSTALL_HELP_KEY = "cine:passage-install-help";

/** « ABCD-EFGH » : le code tel qu'on le lit et le recopie. */
export function formatPassageCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Les réglages de l'appareil (liste blanche) et son abonnement aux notifications, s'il en a un. */
export async function collectPassageInput(): Promise<{ settings: PassageSettings; pushEndpoint: string | null }> {
  let settings: PassageSettings = {};
  try {
    settings = readPassageSettings(window.localStorage, persistedCacheAccount());
  } catch {
    /* stockage illisible : rien ne voyage, le passage se fait quand même */
  }
  let pushEndpoint: string | null = null;
  try {
    if ("serviceWorker" in navigator) {
      // `getRegistration` et non `ready`, qui attend sans fin un worker absent (`pushOnSignOut`).
      const reg = await navigator.serviceWorker.getRegistration();
      pushEndpoint = (await reg?.pushManager?.getSubscription())?.endpoint ?? null;
    }
  } catch {
    pushEndpoint = null;
  }
  return { settings, pushEndpoint };
}

/**
 * Le lien « nouvelle adresse » de la page Nouveautés ouvre le passage plutôt que l'adresse nue : le
 * cinéma monté s'inscrit ici (`PassageBanner`), et le lien lui demande. Rien d'inscrit — la page vue
 * hors du cinéma, ou sur une installation sans passage — : le lien s'ouvre comme avant.
 */
let opener: ((link: string) => boolean) | null = null;

export function registerPassageOpener(fn: ((link: string) => boolean) | null): void {
  opener = fn;
}

/** Vrai si le passage a pris le lien en charge. */
export function openPassageFor(link: string): boolean {
  try {
    return opener?.(link) ?? false;
  } catch {
    return false;
  }
}

function flag(storage: "local" | "session", key: string, value?: string | null): string | null {
  try {
    const s = storage === "local" ? window.localStorage : window.sessionStorage;
    if (value === undefined) return s.getItem(key);
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* stockage refusé */
  }
  return null;
}

/** Le jour local de l'appareil, « AAAA-MM-JJ » (son fuseau, pas UTC). */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Le bandeau refermé **aujourd'hui** (DECISIONS.md §119) : fermé à la croix ou après « Passer », il
 * revient le lendemain, une fois par jour, tant que l'appareil ouvre l'ancienne adresse (souhait du
 * propriétaire, 23/10/2026 — refermé pour toujours, il laissait des appareils sur l'ancienne adresse
 * sans plus rien leur dire). La clé garde le jour de la fermeture ; une valeur d'avant ce changement
 * (« 1 », une date en millisecondes) vaut « fermé aujourd'hui » et est réécrite avec ce jour, pour
 * revenir dès demain.
 */
function bannerClosedToday(): boolean {
  const stored = flag("local", PASSAGE_BANNER_CLOSED_KEY);
  if (stored === null) return false;
  const today = localDay();
  if (/^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored === today;
  flag("local", PASSAGE_BANNER_CLOSED_KEY, today);
  return true;
}

export const passageFlags = {
  bannerClosed: bannerClosedToday,
  closeBanner: () => void flag("local", PASSAGE_BANNER_CLOSED_KEY, localDay()),
  installHelpWanted: () => flag("session", PASSAGE_INSTALL_HELP_KEY) !== null,
  wantInstallHelp: () => void flag("session", PASSAGE_INSTALL_HELP_KEY, "1"),
  installHelpShown: () => void flag("session", PASSAGE_INSTALL_HELP_KEY, null),
  appliedAt: () => flag("local", PASSAGE_APPLIED_KEY),
  noteApplied: (at: number) => void flag("local", PASSAGE_APPLIED_KEY, String(at)),
};
