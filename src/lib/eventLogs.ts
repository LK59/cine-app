// Deux journaux de plus, pour la page d'activité : les connexions et les notifications.
//
// Ni l'un ni l'autre n'existait. Un compte dont on avait réinitialisé le mot de passe plusieurs
// fois ne laissait aucune trace de ses tentatives, et une notification partie — ou refusée par un
// abonnement expiré — ne se lisait nulle part (24/09/2026). Même forme que les autres journaux :
// une ligne JSON par événement, tournée à 5 Mo (`logFile.ts`), vingt archives chacun.

import path from "node:path";
import { LOG_DIR, appendJsonLine } from "@/lib/logFile";

export const AUTH_LOG = () => path.join(LOG_DIR, "auth.log");
export const NOTIFICATIONS_LOG = () => path.join(LOG_DIR, "notifications.log");
export const EVENT_LOG_KEEP = 20;

/**
 * Chaque ouverture du cinéma : depuis le cache de l'appareil ou depuis le réseau, et en combien de
 * temps (25/09/2026). Le cache du catalogue promettait des affiches dès l'ouverture plutôt qu'après
 * une à deux secondes d'itinérance : ce journal dit ce qu'il fait gagner, au lieu de le supposer.
 */
export const STARTUP_LOG = () => path.join(LOG_DIR, "startup.log");

/** Ne lève jamais : une mesure perdue ne coûte rien à personne. */
export function logStartupTiming(fields: {
  user: string;
  device: string | null;
  build: string | null;
  /** La version de package.json que le navigateur exécutait, à côté du build. */
  version: string | null;
  cacheUsed: boolean;
  cacheAgeMs: number | null;
  cacheMs: number | null;
  networkMs: number | null;
  /** Le démarrage du code : quand la lecture du cache commence (depuis la navigation). */
  bootMs?: number | null;
  /** La lecture d'IndexedDB elle-même, du début à la fin. */
  idbMs?: number | null;
  /** L'arrivée de « Reprendre » par le réseau (depuis la navigation). */
  resumeNetworkMs?: number | null;
  /** Quand la page est passée en arrière-plan avant la fin de l'ouverture — mesures d'après omises. */
  hiddenAtMs?: number;
  standalone: boolean;
  /** Le stockage de l'appareil — voir `storageFacts` (persistentCache.ts). */
  persist?: string;
  persisted?: boolean;
  quotaMB?: number;
  usageMB?: number;
  idbMB?: number;
  cacheMB?: number;
  opfsMB?: number;
  resumeTitles?: number;
  resumeMB?: number;
  storageTimedOut?: boolean;
  storageMode?: string;
}): void {
  try {
    appendJsonLine(STARTUP_LOG(), { timestamp: new Date().toISOString(), kind: "ouverture", ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* rien */
  }
}

export type AuthEvent =
  /** Connexion réussie. */
  | "login"
  /** Mot de passe refusé, compte inconnu, serveur injoignable. */
  | "login-failed"
  /** « Se déconnecter ». */
  | "logout"
  /** « Déconnecter tous les autres ». */
  | "others-closed"
  /** Fermée par l'administrateur depuis l'activité. */
  | "closed-by-admin"
  /** Fermée parce que Jellyfin refusait son jeton (mot de passe changé). */
  | "token-refused"
  /** Sessions expirées effacées au passage d'une connexion. */
  | "expired"
  /** Appareils « CineApp » inactifs depuis trente jours supprimés chez Jellyfin (`jellyfinDevicePrune.ts`). */
  | "devices-pruned"
  /** Mot de passe du compte administrateur de l'assistant changé (les autres sessions fermées). */
  | "password-changed"
  /** Tags bloqués posés d'office sur un compte Jellyfin découvert (`newAccountTags.ts`). */
  | "new-account-tags";

/** Ne lève jamais : un journal qui échoue ne doit pas empêcher quelqu'un de se connecter. */
export function logAuthEvent(kind: AuthEvent, fields: { user: string; device?: string | null; ip?: string | null } & Record<string, unknown>): void {
  try {
    appendJsonLine(AUTH_LOG(), { timestamp: new Date().toISOString(), kind, ...fields }, { keep: EVENT_LOG_KEEP });
  } catch {
    /* le disque plein ne doit pas bloquer une connexion */
  }
}

/** Une notification envoyée : à qui, et ce qu'il en est advenu, appareil par appareil. */
export function logNotificationSent(fields: {
  category: string | null;
  title: string;
  body: string;
  /** Par compte : envoyées, refusées (abonnement expiré, retiré), écartées par ses réglages. */
  recipients: { user: string; sent: number; failed: number; removed: number; muted: boolean }[];
}): void {
  try {
    appendJsonLine(
      NOTIFICATIONS_LOG(),
      { timestamp: new Date().toISOString(), kind: fields.category ?? "sans catégorie", ...fields },
      { keep: EVENT_LOG_KEEP }
    );
  } catch {
    /* une notification partie reste partie, journal ou pas */
  }
}
