import { normalize } from "./search-natural-query";
/**
 * Parcourir la bibliothèque en entier.
 *
 * L'accueil est fait de rangées, et chaque rangée s'arrête à vingt-quatre titres : sur six cent
 * soixante-dix films, l'essentiel de la bibliothèque n'était atteignable qu'en sachant d'avance
 * ce qu'on cherchait. Ce module tient les mathématiques de la grille qui répond à ce manque —
 * quoi montrer, dans quel ordre, et ce que les filtres retiennent.
 *
 * Volontairement sans DOM ni React : c'est du tri et du filtrage, et ça se vérifie ligne à ligne.
 */

/** Le peu qu'il faut d'un titre pour le ranger. Films et séries le portent tous les deux. */
export interface BrowsableTitle {
  title: string;
  /** Le titre de Radarr/Sonarr quand on en affiche un autre, et le titre d'origine : cherchables aussi. */
  aka?: string;
  originalTitle?: string;
  year: number;
  genres: string[];
  addedAt: string | null;
  imdbRating: string | null;
  /** La durée d'un film, en minutes ; absente pour une série, ou quand on ne la connaît pas. */
  runtimeMinutes?: number | null;
}

export type BrowseSort = "added" | "title" | "year" | "rating";

export const BROWSE_SORTS: BrowseSort[] = ["added", "title", "year", "rating"];

/** La valeur qui, dans l'adresse, veut dire « tout » plutôt qu'un genre. */
export const BROWSE_ALL = "*";

/**
 * Une note IMDb comparable.
 *
 * Elle arrive en texte — « 7.8 », parfois vide, parfois absente. Un titre sans note se range
 * après tous les autres plutôt qu'avec les zéros : ne pas être noté n'est pas être mauvais.
 */
function ratingOf(item: BrowsableTitle): number {
  const value = Number.parseFloat(item.imdbRating ?? "");
  return Number.isFinite(value) ? value : -1;
}

function addedAtOf(item: BrowsableTitle): number {
  const time = item.addedAt ? Date.parse(item.addedAt) : NaN;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Trier.
 *
 * Le titre départage partout ailleurs qu'en tri alphabétique : deux films de 2019 sans autre
 * critère se suivraient sinon dans l'ordre où le serveur les a envoyés, qui change d'une réponse
 * à l'autre — une grille qui se réordonne toute seule entre deux visites.
 *
 * `localeCompare` avec `numeric` pour que « Rocky 2 » précède « Rocky 10 », et sans sensibilité
 * aux accents pour que « Élève » se range à sa place et non après « Zéro ».
 */
export function sortTitles<T extends BrowsableTitle>(items: T[], sort: BrowseSort): T[] {
  const byTitle = (a: T, b: T) => a.title.localeCompare(b.title, "fr", { numeric: true, sensitivity: "base" });
  const sorted = [...items];
  switch (sort) {
    case "title":
      return sorted.sort(byTitle);
    case "year":
      return sorted.sort((a, b) => b.year - a.year || byTitle(a, b));
    case "rating":
      return sorted.sort((a, b) => ratingOf(b) - ratingOf(a) || byTitle(a, b));
    case "added":
    default:
      return sorted.sort((a, b) => addedAtOf(b) - addedAtOf(a) || byTitle(a, b));
  }
}

/**
 * Les décennies réellement présentes, de la plus récente à la plus ancienne.
 *
 * Déduites de la bibliothèque plutôt que posées à l'avance : un filtre qui propose « 1950 » à
 * quelqu'un qui n'a rien d'avant 1970 lui fait perdre son temps trois fois avant qu'il n'y
 * revienne plus.
 */
export function decadesOf(items: BrowsableTitle[]): number[] {
  const found = new Set<number>();
  for (const item of items) if (item.year > 0) found.add(Math.floor(item.year / 10) * 10);
  return [...found].sort((a, b) => b - a);
}

/**
 * La durée, souvent le vrai critère d'un soir : « moins de 1 h 45 » (23/09/2026).
 *
 * Des seuils plutôt qu'un curseur — on ne choisit pas un film à la minute près — et un film dont
 * la durée est inconnue ne passe aucun d'eux : on ne peut pas affirmer qu'il tient dans la soirée.
 * Pour les films seulement ; le catalogue ne porte pas la durée d'une série.
 */
export type BrowseDuration = "all" | "under90" | "under105" | "under120" | "over120";

export const BROWSE_DURATIONS: BrowseDuration[] = ["all", "under90", "under105", "under120", "over120"];

function matchesDuration(item: BrowsableTitle, duration: BrowseDuration): boolean {
  if (duration === "all") return true;
  const minutes = item.runtimeMinutes;
  if (!minutes || minutes <= 0) return false;
  switch (duration) {
    case "under90":
      return minutes < 90;
    case "under105":
      return minutes < 105;
    case "under120":
      return minutes < 120;
    case "over120":
      return minutes >= 120;
  }
}

export interface BrowseFilters {
  /** Un nom de genre, ou `BROWSE_ALL`. */
  genre: string;
  /** Le début d'une décennie, ou null pour toutes. */
  decade: number | null;
  sort: BrowseSort;
  /** Ce qui est tapé dans le champ de recherche de la grille, s'il y en a. */
  query: string;
  /** Voir `BrowseDuration` ; absent vaut « toutes ». */
  duration?: BrowseDuration;
}

export const DEFAULT_FILTERS: BrowseFilters = { genre: BROWSE_ALL, decade: null, sort: "added", query: "" };

/** Ce que la grille montre : filtrée puis triée, dans cet ordre. */
export function browseTitles<T extends BrowsableTitle>(items: T[], filters: BrowseFilters): T[] {
  // Sans accents ni casse, et sur les trois titres : « eleve » trouvait pas « Élève », et le titre
  // anglais qu'on n'affiche plus depuis les titres traduits n'était plus cherchable ici, alors
  // qu'il l'est dans la recherche (23/09/2026).
  const needle = normalize(filters.query.trim());
  const kept = items.filter((item) => {
    if (filters.genre !== BROWSE_ALL && !item.genres.includes(filters.genre)) return false;
    if (filters.decade !== null && Math.floor(item.year / 10) * 10 !== filters.decade) return false;
    if (needle && ![item.title, item.aka, item.originalTitle].some((t) => t && normalize(t).includes(needle))) return false;
    if (!matchesDuration(item, filters.duration ?? "all")) return false;
    return true;
  });
  return sortTitles(kept, filters.sort);
}
