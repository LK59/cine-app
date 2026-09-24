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
  | "expired";

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
