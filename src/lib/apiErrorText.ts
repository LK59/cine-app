import { isApiErrorCode } from "@/lib/apiErrorCodes";
import type { Locale } from "@/lib/i18n";

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Ce que l'écran dit d'une erreur venue d'une route, dans la langue du compte.
 *
 * Un code connu (`apiErrorCodes.ts`) se traduit par `errors.codes.<code>`. Sans code, le message
 * n'est cité qu'à un compte en français — c'est la langue dans laquelle les routes l'écrivent, et
 * c'est ce qu'il voyait déjà. Aux autres, le repli de l'appelant ou la phrase générique : avant le
 * 13/10/2026, « Le nouveau mot de passe est identique à l'actuel » arrivait tel quel à un compte en
 * anglais.
 */
export function apiErrorText(error: unknown, t: T, locale: Locale, fallback?: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (isApiErrorCode(code)) return t(`errors.codes.${code}`);
  if (locale === "fr" && error instanceof Error && error.message) return error.message;
  return fallback ?? t("errors.generic");
}
