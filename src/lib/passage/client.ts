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
 * Les fermetures du bandeau gardées par les 10.0.x (« une fois par jour », puis « pour toujours » en
 * 10.0.0). Depuis le 24/10/2026 la fermeture ne vit que dans la page — le bandeau revient à chaque
 * lancement sur l'ancienne adresse (DECISIONS.md §119) — : ces clés ne sont plus relues, seulement
 * effacées.
 */
export const PASSAGE_BANNER_CLOSED_KEYS = ["cine:passage-banner-closed-day", "cine:passage-banner-closed"] as const;
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

export const passageFlags = {
  forgetBannerClosed: () => {
    for (const key of PASSAGE_BANNER_CLOSED_KEYS) if (flag("local", key) !== null) flag("local", key, null);
  },
  carriedDownloads: () => flag("session", PASSAGE_CARRIED_DOWNLOADS_KEY) !== null,
  noteCarriedDownloads: (carried: boolean) => void flag("session", PASSAGE_CARRIED_DOWNLOADS_KEY, carried ? "1" : null),
  installHelpWanted: () => flag("session", PASSAGE_INSTALL_HELP_KEY) !== null,
  wantInstallHelp: () => void flag("session", PASSAGE_INSTALL_HELP_KEY, "1"),
  installHelpShown: () => void flag("session", PASSAGE_INSTALL_HELP_KEY, null),
  appliedAt: () => flag("local", PASSAGE_APPLIED_KEY),
  noteApplied: (at: number) => void flag("local", PASSAGE_APPLIED_KEY, String(at)),
};
