import { FILE_MISSING, UPSTREAM_UNREACHABLE } from "@/lib/http";

/**
 * Les refus du serveur qu'un spectateur peut lire, nommés par un code stable.
 *
 * Les routes répondent `{ error }` en français — c'est ce que garde le journal et ce que lit
 * l'administration. Mais ce texte arrivait tel quel à l'écran des comptes en anglais, espagnol ou
 * allemand : « Le nouveau mot de passe est identique à l'actuel » sur un téléphone réglé en anglais
 * (chasse aux bugs du 13/10/2026). Le code voyage à côté du message, et l'écran le traduit par
 * `errors.codes.<code>` (`apiErrorText`). Même motif que `upstream_unreachable` et `file_missing`,
 * repris tels quels.
 *
 * Un code ajouté ici exige sa clé dans les quatre dictionnaires — `apiErrorText.test.ts` le vérifie.
 */
export const API_ERROR_CODES = [
  UPSTREAM_UNREACHABLE,
  FILE_MISSING,
  "invalid_request",
  "jellyfin_account_required",
  "password_required",
  "password_too_short",
  "same_password",
  "wrong_password",
  "requests_unavailable",
  "request_identity_pending",
  "request_seasons_required",
  "request_duplicate",
  "request_quota",
  "request_refused",
  "request_not_found",
  "title_not_found",
  "not_in_list",
  "service_unavailable",
  // Posé par le navigateur lui-même (`apiAction`), jamais par une route : le serveur n'a pas été
  // joint. Voir BUREAU-7 (15/10/2026).
  "network",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(API_ERROR_CODES);

export function isApiErrorCode(code: unknown): code is ApiErrorCode {
  return typeof code === "string" && KNOWN.has(code);
}

/** Le corps d'un refus : le message français pour le journal, le code pour l'écran. */
export function errorBody(error: string, code: ApiErrorCode): { error: string; code: ApiErrorCode } {
  return { error, code };
}
