export type Locale = "fr" | "en" | "es";

export const LOCALE_COOKIE = "cine-lang";
export const DEFAULT_LOCALE: Locale = "fr";
export const LOCALES: Locale[] = ["fr", "en", "es"];

export const LOCALE_LABELS: Record<Locale, string> = {
  fr: "Français",
  en: "English",
  es: "Español",
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
  return (await import("@/locales/fr.json")).default as Record<string, unknown>;
}

export function getLocaleFromCookie(cookieStr: string): Locale {
  const match = cookieStr.match(/(?:^|;\s*)cine-lang=([^;]+)/);
  const val = match?.[1];
  if (val === "fr" || val === "en" || val === "es") return val;
  return DEFAULT_LOCALE;
}

export function getTmdbLocale(locale: string | undefined | null): string {
  switch (locale) {
    case "en": return "en-US";
    case "es": return "es-ES";
    default:   return "fr-FR";
  }
}

export function getVideoLangs(locale: string | undefined | null): string {
  switch (locale) {
    case "en": return "en,null";
    case "es": return "es,en,null";
    default:   return "fr,en,null";
  }
}
