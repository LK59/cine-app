"use client";

import { apiErrorText } from "@/lib/apiErrorText";
import type { Locale } from "@/lib/i18n";

/**
 * Ce que le côté administrateur des liens de partage (DECISIONS.md §112) partage entre la fenêtre de
 * création et la vue Partages de l'Activité : l'adresse des routes, les durées proposées, la copie
 * dans le presse-papiers et la phrase d'une erreur.
 *
 * Les bornes sont celles de `share/store.ts`, recopiées parce que ce module-là ouvre la base et ne
 * peut pas entrer dans le navigateur ; `share-admin-ui.test.tsx` échoue si les deux divergent.
 */

export const SHARE_ADMIN_KEY = "/api/admin/shares";
/** Les durées de la création, en jours — `SHARE_DURATIONS_DAYS`. */
export const SHARE_DAYS_CHOICES = [1, 3, 7, 14, 30] as const;
/** Une semaine : assez pour un film recommandé, pas assez pour qu'un lien oublié vive un mois. */
export const SHARE_DEFAULT_DAYS = 7;
/** Les prolongations proposées dans l'Activité — chacune à partir de la fin si elle est à venir. */
export const SHARE_EXTEND_CHOICES = [1, 7, 30] as const;
export const SHARE_LABEL_MAX_CLIENT = 40;
export const SHARE_MAX_STREAMS_CLIENT = 3;

/** L'adresse complète à envoyer — le serveur ne rend que le chemin, il ne sait pas sous quel nom on l'atteint. */
export function shareUrl(path: string): string {
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

/**
 * Copier un texte, et dire si c'est fait.
 *
 * `navigator.clipboard` n'existe qu'en contexte sûr et peut refuser (Safari hors geste, permission
 * retirée) ; le vieux `execCommand("copy")` sur une zone de texte hors écran prend alors le relais.
 * Un échec ne lève jamais : l'appelant dit à l'écran de sélectionner le texte, qui reste affiché.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Le repli ci-dessous.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Les codes que les routes des liens rendent (`ShareError`), traduits — le message, lui, n'est qu'en français. */
const SHARE_CODES: Record<string, string> = {
  label: "share.admin.errors.label",
  days: "share.admin.errors.days",
  item: "share.admin.errors.item",
  kind: "share.admin.errors.item",
  missing: "share.admin.errors.missing",
  revoked: "share.admin.errors.revoked",
  deleted: "share.admin.errors.deleted",
  "share-unavailable": "share.admin.errors.unavailable",
};

export function shareErrorText(error: unknown, t: T, locale: Locale): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SHARE_CODES[code]) return t(SHARE_CODES[code]);
  return apiErrorText(error, t, locale, t("share.admin.errors.generic"));
}

export interface CreatedShareLink {
  id: string;
  code: string;
  path: string;
  password: string;
  expiresAt: number;
  title: string;
  label: string;
}
