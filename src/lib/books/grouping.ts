import type { BookSummary } from "@/lib/books/types";

/**
 * La grille des livres en rangées (DECISIONS.md §127) : une par série, dans l'ordre où le serveur les
 * a triées (série, tome, nom — `compareBooks`), puis une pour les livres sans série. Un livre sans
 * tome reste dans sa série, après les tomes numérotés.
 */
export interface BookGroup {
  key: string;
  series: string | null;
  books: BookSummary[];
}

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
