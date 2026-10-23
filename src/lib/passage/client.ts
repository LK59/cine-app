"use client";

import { readPassageSettings, type PassageSettings } from "./settings";
import { persistedCacheAccount } from "@/lib/persistentCache";
import { collectPassageDownloads } from "./offer";
import type { PassageDownload } from "./downloads";

/**
 * Le passage d'adresse côté navigateur (DECISIONS.md §119) — ce que l'ancienne adresse rassemble, et
 * ce que la nouvelle se rappelle entre deux pages.
 */

/**
 * Le bandeau refermé sur cet appareil (par adresse — `localStorage` l'est) : « AAAA-MM-JJ|génération »,
 * le jour local de la fermeture et la génération du bandeau à ce moment-là.
 */
export const PASSAGE_BANNER_CLOSED_KEY = "cine:passage-banner-closed-day";
/**
 * La génération de la proposition de passer (DECISIONS.md §119). Une fermeture faite sous une
 * génération plus ancienne ne cache rien : **incrémenter cette constante relance la proposition chez
 * tout le monde** dès la mise en ligne, sans changer de clé. 1 : la 10.0.1 (sa valeur n'avait pas de
 * génération, lue comme 1) ; 2 : les téléchargements suivent le passage.
 */
export const PASSAGE_BANNER_GENERATION = 2;
/**
 * La clé de la 10.0.0, où une fermeture valait pour toujours : jamais relue, effacée au lancement.
 */
export const PASSAGE_BANNER_CLOSED_LEGACY_KEY = "cine:passage-banner-closed";
/** Arrivé par un passage qui emporte des téléchargements (onglet) : l'aide d'installation le dit. */
export const PASSAGE_CARRIED_DOWNLOADS_KEY = "cine:passage-carried-downloads";
/** Les réglages arrivés déjà posés sur ce stockage : la date de l'arrivée (`passageArrival`). */
export const PASSAGE_APPLIED_KEY = "cine:passage-applied";
/** Arrivé par le passage dans cet onglet : l'aide « Ajouter à l'écran d'accueil » se montre aussitôt. */
export const PASSAGE_INSTALL_HELP_KEY = "cine:passage-install-help";

/** « ABCD-EFGH » : le code tel qu'on le lit et le recopie. */
export function formatPassageCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Les réglages de l'appareil (liste blanche), son abonnement aux notifications s'il en a un, et la
 * liste de ses téléchargements hors ligne de ce compte (`collectPassageDownloads`) — jamais les fichiers.
 */
export async function collectPassageInput(): Promise<{ settings: PassageSettings; pushEndpoint: string | null; downloads: PassageDownload[] }> {
  const downloads = await collectPassageDownloads();
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
  return { settings, pushEndpoint, downloads };
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
 * sans plus rien leur dire). La clé garde le jour de la fermeture **et la génération du bandeau**
 * (`PASSAGE_BANNER_GENERATION`) : une fermeture d'une génération plus ancienne — ou sans génération,
 * celle de la 10.0.1 — ne cache rien. La clé de la 10.0.0 est oubliée et effacée.
 */
export function bannerClosedToday(stored: string | null, day: string = localDay(), generation: number = PASSAGE_BANNER_GENERATION): boolean {
  if (stored === null) return false;
  const [closedDay, gen] = stored.split("|");
  const closedGeneration = gen === undefined ? 1 : Number(gen);
  return closedDay === day && Number.isInteger(closedGeneration) && closedGeneration >= generation;
}

function readBannerClosed(): boolean {
  if (flag("local", PASSAGE_BANNER_CLOSED_LEGACY_KEY) !== null) flag("local", PASSAGE_BANNER_CLOSED_LEGACY_KEY, null);
  return bannerClosedToday(flag("local", PASSAGE_BANNER_CLOSED_KEY));
}

export const passageFlags = {
  bannerClosed: readBannerClosed,
  closeBanner: () => void flag("local", PASSAGE_BANNER_CLOSED_KEY, `${localDay()}|${PASSAGE_BANNER_GENERATION}`),
  carriedDownloads: () => flag("session", PASSAGE_CARRIED_DOWNLOADS_KEY) !== null,
  noteCarriedDownloads: (carried: boolean) => void flag("session", PASSAGE_CARRIED_DOWNLOADS_KEY, carried ? "1" : null),
  installHelpWanted: () => flag("session", PASSAGE_INSTALL_HELP_KEY) !== null,
  wantInstallHelp: () => void flag("session", PASSAGE_INSTALL_HELP_KEY, "1"),
  installHelpShown: () => void flag("session", PASSAGE_INSTALL_HELP_KEY, null),
  appliedAt: () => flag("local", PASSAGE_APPLIED_KEY),
  noteApplied: (at: number) => void flag("local", PASSAGE_APPLIED_KEY, String(at)),
};
