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

/**
 * Le singulier ou le pluriel, choisis par la règle de la langue.
 *
 * Une traduction peut porter deux formes séparées par `|` — « {n} autre appareil|{n} autres
 * appareils » — et `n` choisit. Avant (23/09/2026), onze chaînes écrivaient « appareil(s)
 * connecté(s) » : un brouillon laissé à l'écran. La règle vient d'`Intl.PluralRules`, pas d'un
 * `n === 1` : en français, zéro est singulier (« 0 autre appareil »), en anglais non.
 */
function pickPlural(str: string, locale: Locale, vars?: Record<string, string | number>): string {
  if (!str.includes("|") || typeof vars?.n !== "number") return str;
  const [one, other] = str.split("|");
  return new Intl.PluralRules(locale).select(vars.n) === "one" ? one : (other ?? one);
}

export function createT(
  dict: Record<string, unknown>,
  fallback: Record<string, unknown>,
  locale: Locale = DEFAULT_LOCALE
) {
  return function t(key: string, vars?: Record<string, string | number>): string {
    const val = get(dict, key) ?? get(fallback, key) ?? key;
    return interpolate(pickPlural(val, locale, vars), vars);
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

/**
 * La langue d'une requête, lue sur son cookie.
 *
 * Les routes qui servent des visuels en ont besoin — l'affiche d'un film suit la langue de qui
 * regarde — et elles reçoivent un `Request` nu, sans l'aide de Next sur les cookies. Une ligne,
 * mais écrite trois fois avant d'atterrir ici.
 */
export function localeOf(req: { headers?: { get(name: string): string | null } }): Locale {
  // Une requête sans en-têtes n'est pas une anomalie à signaler : le français est la valeur par
  // défaut de cette installation, et c'est exactement ce que rend un cookie absent.
  const cookie = req.headers?.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  const raw = match ? decodeURIComponent(match[1]) : "";
  return LOCALES.includes(raw as Locale) ? (raw as Locale) : "fr";
}
