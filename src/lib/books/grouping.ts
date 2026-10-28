import type { BookSummary } from "@/lib/books/types";

/**
 * Les livres en rangées et en grille (DECISIONS.md §127), pensés pour une bibliothèque de plusieurs
 * milliers d'EPUB : l'accueil ne montre que des rangées bornées, chacune avec son « Tout voir », et la
 * grille complète se filtre et se dessine par morceaux.
 */

export interface BookGroup {
  key: string;
  series: string | null;
  books: BookSummary[];
}

/** La clé d'une série dans l'adresse de la grille (`/livres?serie=…`) ; les livres sans série ont la leur. */
export const NO_SERIES = "*autres";

/**
 * Une rangée par série, dans l'ordre où le serveur les a triées (série, tome, nom — `compareBooks`),
 * puis une pour les livres sans série. Un livre sans tome reste dans sa série, après les tomes numérotés.
 */
export function groupBooks(books: readonly BookSummary[]): BookGroup[] {
  const bySeries = new Map<string, BookGroup>();
  const others: BookSummary[] = [];
  for (const book of books) {
    if (!book.seriesName) {
      others.push(book);
      continue;
    }
    // La casse seule ne fait pas deux séries (« CHERUB » et « Cherub »).
    const key = book.seriesName.toLocaleLowerCase();
    const group = bySeries.get(key) ?? { key: `s:${key}`, series: book.seriesName, books: [] };
    group.books.push(book);
    bySeries.set(key, group);
  }
  const groups = [...bySeries.values()];
  if (others.length > 0) groups.push({ key: "others", series: null, books: others });
  return groups;
}

/** « Continuer la lecture » : commencés, pas finis, le plus récent d'abord. */
export function continueReading(books: readonly BookSummary[], limit = 12): BookSummary[] {
  return books
    .filter((b) => b.progress && !b.progress.finished && b.progress.fraction > 0)
    .sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0))
    .slice(0, limit);
}

export interface HomeRows {
  resume: BookSummary[];
  /** Les derniers arrivés, quand la bibliothèque est assez grande pour qu'ils s'y perdent. */
  recent: BookSummary[];
  /** Les séries montrées, chacune réduite à `perRow` livres ; `total` dit combien elle en a. */
  rows: (BookGroup & { total: number })[];
  /** Combien de séries (ou « autres ») ne tiennent pas sur l'accueil — la grille complète les montre. */
  hiddenGroups: number;
}

/**
 * L'accueil de la catégorie Livres, borné quelle que soit la taille de la bibliothèque : au plus
 * `maxRows` rangées de séries — celles où l'on a lu en dernier, puis les plus récemment enrichies —, de
 * `perRow` livres chacune, et les livres sans série en une rangée « Autres livres » bornée de même. Le
 * reste est dans la grille complète, à un « Tout voir ».
 */
export function homeRows(books: readonly BookSummary[], { maxRows = 8, perRow = 20 } = {}): HomeRows {
  const groups = groupBooks(books);
  const lastRead = (g: BookGroup) => Math.max(0, ...g.books.map((b) => (b.progress && !b.progress.finished ? b.progress.updatedAt : 0)));
  const lastAdded = (g: BookGroup) => Math.max(0, ...g.books.map((b) => b.addedAt ?? 0));
  const series = groups.filter((g) => g.series !== null);
  const others = groups.find((g) => g.series === null) ?? null;
  // Une petite bibliothèque garde l'ordre alphabétique ; une grande montre ce qui bouge.
  const ranked = series.length > maxRows ? [...series].sort((a, b) => lastRead(b) - lastRead(a) || lastAdded(b) - lastAdded(a)) : series;
  const shown = ranked.slice(0, maxRows);
  const rows = [...shown, ...(others ? [others] : [])].map((g) => ({ ...g, total: g.books.length, books: g.books.slice(0, perRow) }));
  const recent =
    books.length > perRow * 2
      ? [...books].filter((b) => b.addedAt !== null).sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)).slice(0, perRow)
      : [];
  return { resume: continueReading(books), recent, rows, hiddenGroups: series.length - shown.length };
}

/** Sans accents ni casse : « Dérive » se trouve en tapant « derive ». */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

/**
 * La grille filtrée : par série (`serie`, dont `NO_SERIES`), puis par les mots tapés — chacun doit se
 * trouver dans le titre, la série ou un auteur.
 */
export function filterBooks(books: readonly BookSummary[], query: string, serie: string | null = null): BookSummary[] {
  let out = books as BookSummary[];
  if (serie === NO_SERIES) out = out.filter((b) => !b.seriesName);
  else if (serie) {
    const key = serie.toLocaleLowerCase();
    out = out.filter((b) => b.seriesName?.toLocaleLowerCase() === key);
  }
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return out;
  return out.filter((b) => {
    const hay = foldText([b.name, b.seriesName ?? "", ...b.authors].join(" "));
    return words.every((w) => hay.includes(w));
  });
}
