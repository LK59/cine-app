export type Locale = "fr" | "en" | "es" | "de";

export const LOCALE_COOKIE = "cine-lang";
export const DEFAULT_LOCALE: Locale = "fr";
export const LOCALES: Locale[] = ["fr", "en", "es", "de"];

export const LOCALE_LABELS: Record<Locale, string> = {
  fr: "Français",
  en: "English",
  es: "Español",
  de: "Deutsch",
};

function get(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let curr: unknown = obj;
  for (const p of parts) {
    if (curr == null || typeof curr !== "object") return undefined;
    curr = (curr as Record<string, unknown>)[p];
  }
  return typeof curr === "string" ? curr : undefined;
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? `{${key}}`));
}

export function createT(
  dict: Record<string, unknown>,
  fallback: Record<string, unknown>
) {
  return function t(key: string, vars?: Record<string, string | number>): string {
    const val = get(dict, key) ?? get(fallback, key) ?? key;
    return interpolate(val, vars);
  };
}

export async function loadLocaleDict(locale: Locale): Promise<Record<string, unknown>> {
  if (locale === "en") return (await import("@/locales/en.json")).default as Record<string, unknown>;
  if (locale === "es") return (await import("@/locales/es.json")).default as Record<string, unknown>;
  if (locale === "de") return (await import("@/locales/de.json")).default as Record<string, unknown>;
  return (await import("@/locales/fr.json")).default as Record<string, unknown>;
}

export function getLocaleFromCookie(cookieStr: string): Locale | null {
  const match = cookieStr.match(/(?:^|;\s*)cine-lang=([^;]+)/);
  const val = match?.[1];
  if (val === "fr" || val === "en" || val === "es" || val === "de") return val;
  return null;
}

export function getTmdbLocale(locale: string | undefined | null): string {
  switch (locale) {
    case "en": return "en-US";
    case "es": return "es-ES";
    case "de": return "de-DE";
    default:   return "fr-FR";
  }
}

// Same mapping, for Intl/toLocaleDateString calls — kept separate from getTmdbLocale so the two
// can diverge if TMDb's regional variant ever needs to differ from the date-formatting one.
export function getDateLocale(locale: string | undefined | null): string {
  switch (locale) {
    case "en": return "en-US";
    case "es": return "es-ES";
    case "de": return "de-DE";
    default:   return "fr-FR";
  }
}

export function getVideoLangs(locale: string | undefined | null): string {
  switch (locale) {
    case "en": return "en,null";
    case "es": return "es,en,null";
    case "de": return "de,en,null";
    default:   return "fr,en,null";
  }
}
