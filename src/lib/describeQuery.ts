/**
 * Ce qui décide qu'une frappe est une description (`describeSearch.ts`), partagé par l'écran et la
 * route — sans React ni SDK, que les deux puissent l'importer.
 */

/** Une frappe en minuscules, sans accents ni ponctuation, espaces simples. */
function folded(query: string): string {
  return query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** La clé d'une phrase : deux frappes qui ne diffèrent que d'accents ou de ponctuation sont la même. */
export function describeKey(query: string): string {
  return folded(query).slice(0, 200);
}

/**
 * Les mots qui disent « je décris » plutôt que « je cite un titre », dans les quatre langues.
 * « Le seigneur des anneaux » n'en a aucun ; « le film où un type revit la même journée » en a trois.
 */
const MARKERS = new Set([
  // fr
  "ou", "qui", "avec", "dans", "sur", "film", "films", "serie", "series", "dessin", "anime", "documentaire",
  "mec", "type", "gars", "homme", "femme", "fille", "garcon", "enfant", "enfants", "histoire", "parle", "truc",
  // en
  "where", "who", "with", "about", "movie", "movies", "show", "guy", "man", "woman", "girl", "boy", "kid", "kids", "cartoon", "documentary",
  // es
  "donde", "que", "con", "sobre", "pelicula", "peliculas", "chico", "chica", "hombre", "mujer",
  // de
  "wo", "mit", "uber", "serie", "serien", "mann", "frau", "madchen", "junge", "zeichentrick",
]);

/** À partir de combien de mots une frappe peut être une description. */
export const DESCRIBE_MIN_WORDS = 4;
/** Au-delà, une frappe est une description même sans mot de la liste. */
const DESCRIBE_LONG_WORDS = 7;

/**
 * Cette frappe décrit-elle un titre ? Quatre mots au moins, dont un qui décrit — ou sept mots.
 * Chaque description est un appel payant et une seconde d'attente : un titre tapé en entier n'en
 * a pas besoin, la recherche ordinaire le trouve.
 */
export function looksLikeDescription(query: string): boolean {
  const words = folded(query).split(" ").filter(Boolean);
  if (words.length < DESCRIBE_MIN_WORDS) return false;
  if (words.length >= DESCRIBE_LONG_WORDS) return true;
  return words.some((w) => MARKERS.has(w));
}

export function describeSearchUrl(query: string): string {
  return `/api/search/describe?q=${encodeURIComponent(query.trim())}`;
}
