/**
 * La langue de tournage d'un film, ramenée à un code comparable.
 *
 * Radarr la nomme en anglais — « English », « French », « Korean » — parce que c'est ainsi que
 * TMDB la donne. Le lecteur, lui, compare des codes : il faut donc traduire une fois, ici.
 *
 * La liste couvre les dix-sept langues présentes dans cette bibliothèque, relevées le 20/09/2026,
 * plus quelques-unes qu'un prochain film peut apporter. **Un nom inconnu rend `null`**, et le
 * lecteur n'affiche alors aucune mention : ne rien dire vaut mieux que dire « (VO) » à côté de la
 * mauvaise piste — c'est la condition qui avait été posée en demandant cette mention.
 */
const CODES: Record<string, string> = {
  english: "en", french: "fr", spanish: "es", german: "de", italian: "it", portuguese: "pt",
  russian: "ru", japanese: "ja", korean: "ko", chinese: "zh", mandarin: "zh", cantonese: "zh",
  danish: "da", swedish: "sv", norwegian: "no", finnish: "fi", polish: "pl", dutch: "nl",
  romanian: "ro", hindi: "hi", persian: "fa", arabic: "ar", turkish: "tr", hebrew: "he",
  estonian: "et", czech: "cs", hungarian: "hu", greek: "el", ukrainian: "uk", thai: "th",
  vietnamese: "vi", indonesian: "id", catalan: "ca", icelandic: "is", latin: "la",
};

export function originalLanguageCode(name: string | null | undefined): string | null {
  if (!name) return null;
  return CODES[name.trim().toLowerCase()] ?? null;
}
