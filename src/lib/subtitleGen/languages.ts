import { normaliseLanguage } from "@/lib/trackPreferences";

/**
 * Les langues vers lesquelles on traduit (DECISIONS.md §69).
 *
 * Une liste fermée, et pas « toute langue qu'Intl connaît » : chacune doit avoir un code ISO 639-2
 * pour le fichier que Jellyfin pose à côté du film (`Film.fra.srt`), et le proposer pour une
 * langue que personne ici ne lit n'aurait servi qu'à dépenser. Les quatre de l'interface d'abord,
 * puis trois voisines courantes dans la bibliothèque.
 */
export const TARGET_LANGUAGES = ["fr", "en", "es", "de", "it", "pt", "nl"] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

/**
 * Le code à trois lettres **terminologique** (`fra`, `deu`) — celui que Jellyfin 12 rend pour les
 * fichiers voisins (`.fr.srt` de Bazarr lu `fra`, vérifié sur l'instance le 12/10/2026). Il sert
 * aussi à nommer notre fichier autrement que ceux de Bazarr (`.fr.srt`) : une collision de nom
 * écraserait un sous-titre qui n'est pas le nôtre.
 */
const ISO_639_2T: Record<TargetLanguage, string> = { fr: "fra", en: "eng", es: "spa", de: "deu", it: "ita", pt: "por", nl: "nld" };

export function isTargetLanguage(code: string | null | undefined): code is TargetLanguage {
  return !!code && (TARGET_LANGUAGES as readonly string[]).includes(code);
}

export function iso639_2(code: TargetLanguage): string {
  return ISO_639_2T[code];
}

/** Une langue de piste ramenée à son code à deux lettres (`fre`, `fra`, `fr-FR` → `fr`), ou null. */
export function twoLetter(code: string | null | undefined): string | null {
  return normaliseLanguage(code);
}

/** Le nom anglais d'une langue, pour les consignes données au modèle (« French », « German »). */
export function englishName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
