/**
 * Chercher et trier dans « Ma liste ».
 *
 * Une liste de quarante titres se parcourt ; à cent, elle se fouille. Les deux opérations tiennent
 * ici, hors de React et hors du DOM, parce que ce sont des questions de données et qu'elles se
 * vérifient ligne à ligne.
 */

export interface SortableListItem {
  title: string;
  year: number | null;
  /** Nul pour ce qui vient de Jellyfin, qui ne dit pas quand un titre a été marqué. */
  addedAt?: number | null;
}

export type ListSort = "added" | "title" | "year";

export const LIST_SORTS: ListSort[] = ["added", "title", "year"];

/**
 * Ne garder que ce dont le titre contient ce qui est tapé.
 *
 * Insensible à la casse et aux espaces de bord. Volontairement sans tolérance à la faute : ici on
 * cherche dans une liste qu'on a soi-même remplie, donc dans des titres qu'on connaît — c'est la
 * recherche générale qui a besoin d'être indulgente, pas celle-ci.
 */
export function filterByTitle<T extends { title: string }>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}

/**
 * Trier.
 *
 * Le titre départage partout ailleurs qu'en tri alphabétique : deux titres sans autre critère se
 * suivraient sinon dans l'ordre du serveur, qui change d'une réponse à l'autre — une liste qui se
 * réordonne toute seule entre deux visites.
 *
 * Une date d'ajout absente passe en dernier plutôt qu'en 1970 : les listes qui viennent de
 * Jellyfin n'en ont pas, et les jeter en tête du tri « récemment ajouté » serait faux dans les
 * deux sens.
 */
export function sortList<T extends SortableListItem>(items: T[], sort: ListSort): T[] {
  const byTitle = (a: T, b: T) => a.title.localeCompare(b.title, "fr", { numeric: true, sensitivity: "base" });
  const sorted = [...items];
  switch (sort) {
    case "title":
      return sorted.sort(byTitle);
    case "year":
      return sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || byTitle(a, b));
    case "added":
    default:
      return sorted.sort((a, b) => {
        const left = a.addedAt ?? -1;
        const right = b.addedAt ?? -1;
        return right - left || byTitle(a, b);
      });
  }
}
