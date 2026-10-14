import { originalLanguageCode } from "@/lib/originalLanguage";

/**
 * Les langues de la recherche de répliques (DECISIONS.md §88), ramenées à deux lettres.
 *
 * Trois sources nomment une langue, chacune à sa façon : le Matroska (`fre`, `fra`, `eng`, ou en
 * BCP 47 `fr-CA`), le nom d'un fichier posé à côté du film (`Film.fr.srt`, `Film.french.forced.srt`,
 * `Film.VFQ.srt`), et Radarr pour la langue de tournage (« French »). La table couvre les langues
 * relevées dans les pistes de cette bibliothèque le 14/10/2026 ; une langue inconnue rend `null` et
 * n'est simplement pas indexée — jamais rangée sous une autre.
 */
const CODES: Record<string, string> = {
  fr: "fr", fre: "fr", fra: "fr", french: "fr", francais: "fr", vf: "fr", vff: "fr", vfi: "fr", vfq: "fr", vf2: "fr", truefrench: "fr",
  en: "en", eng: "en", english: "en", anglais: "en",
  es: "es", spa: "es", spanish: "es", espanol: "es", castellano: "es",
  de: "de", ger: "de", deu: "de", german: "de", deutsch: "de",
  it: "it", ita: "it", italian: "it", italiano: "it",
  pt: "pt", por: "pt", portuguese: "pt",
  nl: "nl", dut: "nl", nld: "nl", dutch: "nl",
  ja: "ja", jpn: "ja", japanese: "ja",
  ko: "ko", kor: "ko", korean: "ko",
  zh: "zh", chi: "zh", zho: "zh", chinese: "zh",
  ru: "ru", rus: "ru", russian: "ru",
  sv: "sv", swe: "sv", swedish: "sv",
  da: "da", dan: "da", danish: "da",
  no: "no", nor: "no", nob: "no", nno: "no", norwegian: "no",
  fi: "fi", fin: "fi", finnish: "fi",
  pl: "pl", pol: "pl", polish: "pl",
  cs: "cs", cze: "cs", ces: "cs", czech: "cs",
  hu: "hu", hun: "hu", hungarian: "hu",
  el: "el", gre: "el", ell: "el", greek: "el",
  ro: "ro", rum: "ro", ron: "ro", romanian: "ro",
  tr: "tr", tur: "tr", turkish: "tr",
  ar: "ar", ara: "ar", arabic: "ar",
  he: "he", heb: "he", hebrew: "he",
  hi: "hi", hin: "hi", hindi: "hi",
  th: "th", tha: "th", thai: "th",
  vi: "vi", vie: "vi", vietnamese: "vi",
  id: "id", ind: "id", indonesian: "id",
  uk: "uk", ukr: "uk", ukrainian: "uk",
  fa: "fa", per: "fa", fas: "fa", persian: "fa",
  ca: "ca", cat: "ca", catalan: "ca",
};

/** Un code de langue tel qu'un fichier ou un conteneur l'écrit, en deux lettres — `null` si inconnu. */
export function languageCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (!value) return null;
  // BCP 47 (`fr-CA`, `pt-BR`, `zh-Hans`) : la langue est la première sous-étiquette.
  const primary = value.split(/[-_]/)[0];
  return CODES[value] ?? CODES[primary] ?? null;
}

/** Les choix proposés dans la Configuration, dans cet ordre. `original` : la langue de tournage du film. */
export const LANGUAGE_CHOICES = ["original", "fr", "en", "es", "de", "it"] as const;

/** Le réglage (`fr,original`) lu en liste propre : codes connus, `original`, sans doublon. */
export function parseLanguageSetting(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    const token = part.trim().toLowerCase();
    const code = token === "original" || token === "vo" ? "original" : languageCode(token);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Les langues à indexer pour un film : le réglage, `original` remplacé par sa langue de tournage
 * (Radarr, « French » → `fr`). Une langue de tournage inconnue n'ajoute rien.
 */
export function languagesForFilm(setting: string, originalLanguageName: string | null | undefined): string[] {
  const out: string[] = [];
  for (const token of parseLanguageSetting(setting)) {
    const code = token === "original" ? originalLanguageCode(originalLanguageName) : token;
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}
