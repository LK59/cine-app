"use client";

import { useCallback } from "react";
import { useLocale, useT } from "@/components/TranslationProvider";
import { apiErrorText } from "@/lib/apiErrorText";

/**
 * `apiErrorText` avec la langue et le dictionnaire du compte : `errorText(err)` dans un `catch`,
 * `errorText(err, t("…"))` quand l'écran a une phrase plus précise que la générique. Stable tant
 * que la langue ne change pas, pour les `useCallback` qui l'appellent.
 */
export function useErrorText(): (error: unknown, fallback?: string) => string {
  const t = useT();
  const { locale } = useLocale();
  return useCallback((error: unknown, fallback?: string) => apiErrorText(error, t, locale, fallback), [t, locale]);
}
