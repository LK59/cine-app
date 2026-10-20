import { FILE_MISSING, HttpError, UPSTREAM_UNREACHABLE } from "@/lib/http";

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
  // Une personne que TMDB ne connaît pas (lien ancien, identifiant mal copié) — ROBUSTESSE-7.
  "person_not_found",
  // Un lien de partage déjà lu sur le nombre d'appareils permis (`shareStreamRefusal`, DECISIONS.md
  // §112). Nommé ici pour que le lecteur serveur, qui traduit la réponse de sa négociation par son
  // code (`apiErrorText`), dise la vraie raison à l'invité au lieu de « lecture impossible ».
  "share-streams",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(API_ERROR_CODES);

export function isApiErrorCode(code: unknown): code is ApiErrorCode {
  return typeof code === "string" && KNOWN.has(code);
}

/**
 * Un 404 de l'amont (TMDB) renommé en refus lisible (15/10/2026, passe de nuit, ROBUSTESSE-7).
 *
 * `fetchJson` lève un `HttpError` dont le message cite le corps de TMDB — `404 Not Found:
 * {"success":false,"status_code":34,…}` —, et `withErrorHandling` le renvoyait tel quel : c'est ce
 * texte qui s'affichait en rouge sur une fiche ouverte depuis un lien ancien. Le statut reste 404 ;
 * le message devient une phrase, et le code la traduit à l'écran. Tout autre échec passe intact.
 */
export async function renameNotFound<T>(work: Promise<T>, message: string, code: ApiErrorCode): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw new HttpError(message, 404, code);
    throw error;
  }
}

/** Le corps d'un refus : le message français pour le journal, le code pour l'écran. */
export function errorBody(error: string, code: ApiErrorCode): { error: string; code: ApiErrorCode } {
  return { error, code };
}
