import { stripSubtitleMarkup, subtitlePlacement, subtitleText } from "@/lib/webcodecs/subtitleMarkup";

/**
 * Le texte d'une réplique, sous ses deux formes (DECISIONS.md §88).
 *
 * - **Affichée** : ce qu'on lit dans un résultat. Les balises (`<i>`, `{\i1}`, `{\an8}`, les repères
 *   de karaoké) partent par le même nettoyage que le lecteur (`subtitleText`, `stripSubtitleMarkup`) —
 *   une réplique de la recherche se lit comme à l'écran. Les retours à la ligne restent : deux
 *   personnes qui se répondent (« - Oui. / - Non. ») sont deux lignes.
 * - **Normalisée** : minuscules, sans accents, sans ponctuation, mots séparés d'une espace — ce que
 *   l'index plein texte voit déjà par lui-même (`unicode61 remove_diacritics 2`), écrit une fois pour
 *   les comparaisons faites hors de SQLite (le bonus d'expression exacte, le vocabulaire des fautes).
 */

/** Plus long que ça n'est pas une réplique : un bloc de générique, une piste mal formée. */
const MAX_TEXT = 400;

/** Une réplique lue dans un conteneur, nettoyée pour l'affichage — vide si rien ne reste. */
export function displayText(raw: string, codecId: string): string {
  // `subtitleText` sait l'ASS (champs avant le texte, \N) et le SubRip ; le WebVTT passe par la même
  // branche que le SubRip (balises à chevrons). La position (`{\an8}`) gardée en tête est retirée.
  const text = subtitlePlacement(subtitleText(raw, codecId)).text;
  return tidy(text);
}

/** Une réplique d'un fichier posé à côté (déjà découpée par le lecteur de fichiers). */
export function displayTextOfFile(raw: string, ass = false): string {
  const text = ass ? raw.replace(/\\N/gi, "\n").replace(/\\h/gi, " ") : raw;
  return tidy(subtitlePlacement(stripSubtitleMarkup(text, { allBraces: ass })).text);
}

function tidy(text: string): string {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\s ]+/g, " ").trim())
    .filter(Boolean);
  const joined = lines.join("\n");
  return joined.length > MAX_TEXT ? joined.slice(0, MAX_TEXT).trimEnd() + "…" : joined;
}

/** Minuscules, sans accents : la forme sur laquelle se comparent les mots. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss");
}

/** Les mots d'un texte, pliés — comme le tokenizer `unicode61` les découpe (l'apostrophe sépare). */
export function words(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** La forme normalisée rangée dans `lines.norm`. */
export function normalizedText(text: string): string {
  return words(text).join(" ");
}
