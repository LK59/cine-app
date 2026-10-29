import type { BookSummary } from "@/lib/books/types";
import { duplicateKey, fold, nameKey, titleCare } from "@/lib/books/metadata";

/**
 * Les livres en rangées et en grille (DECISIONS.md §127), pensés pour une bibliothèque de plusieurs
 * milliers d'EPUB : l'accueil ne montre que des rangées bornées, chacune avec son « Tout voir », et la
 * grille complète se filtre, se trie et se dessine par morceaux.
 */

export interface BookGroup {
  key: string;
  series: string | null;
  books: BookSummary[];
}

/** La clé d'une série dans l'adresse de la grille (`/livres?serie=…`) ; les livres sans série ont la leur. */
export const NO_SERIES = "*autres";

/**
 * Une section par série, dans l'ordre où le serveur les a triées (série, tome, nom — `compareBooks`),
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
    // La casse et les accents seuls ne font pas deux séries (« CHERUB » et « Cherub »).
    const key = fold(book.seriesName);
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
    .filter((b) => b.progress && !b.progress.finished)
    .sort((a, b) => (b.progress?.updatedAt ?? 0) - (a.progress?.updatedAt ?? 0))
    .slice(0, limit);
}

/** Les auteurs d'une bibliothèque, rapprochés quel que soit l'ordre des mots ; le libellé est la forme la plus fréquente. */
export function authorIndex(books: readonly BookSummary[]): Map<string, { label: string; books: BookSummary[] }> {
  type Entry = { forms: Map<string, number>; books: BookSummary[] };
  const out = new Map<string, Entry>();
  for (const book of books) {
    for (const author of new Set(book.authors)) {
      const key = nameKey(author);
      if (!key) continue;
      const entry: Entry = out.get(key) ?? { forms: new Map(), books: [] };
      entry.forms.set(author, (entry.forms.get(author) ?? 0) + 1);
      entry.books.push(book);
      out.set(key, entry);
    }
  }
  return new Map([...out].map(([key, e]) => [key, { label: [...e.forms].sort((a, b) => b[1] - a[1])[0][0], books: e.books }]));
}

/** Les genres d'une bibliothèque, regroupés sans accents ni casse. */
export function genreIndex(books: readonly BookSummary[]): Map<string, { label: string; books: BookSummary[] }> {
  const out = new Map<string, { label: string; books: BookSummary[] }>();
  for (const book of books) {
    for (const genre of book.genres) {
      const key = fold(genre);
      const entry = out.get(key) ?? { label: genre, books: [] };
      entry.books.push(book);
      out.set(key, entry);
    }
  }
  return out;
}

export type RowKind = "series" | "author" | "genre";

export interface HomeRow {
  key: string;
  kind: RowKind;
  title: string;
  /** Ce que « Tout voir » met dans l'adresse de la grille (`serie`, `auteur`, `genre`). */
  filter: { param: "serie" | "auteur" | "genre"; value: string };
  total: number;
  books: BookSummary[];
}

export interface HomeRows {
  resume: BookSummary[];
  recent: BookSummary[];
  rows: HomeRow[];
  /** Combien de séries, d'auteurs et de genres n'ont pas trouvé place — la grille complète les montre. */
  hidden: number;
}

const byYear = (a: BookSummary, b: BookSummary) => (a.year ?? 9999) - (b.year ?? 9999) || a.name.localeCompare(b.name);
const byNewest = (a: BookSummary, b: BookSummary) => (b.addedAt ?? 0) - (a.addedAt ?? 0);

/**
 * L'accueil de la catégorie Livres, dans l'ordre voulu, chaque rangée cachée quand elle est vide :
 * « Continuer la lecture », « Récemment ajoutés », une rangée par **série** (deux livres au moins, dans
 * l'ordre des tomes), une par **auteur** (deux livres au moins, par année ; pas quand tous ses livres sont
 * déjà dans une même série montrée), une par **genre** (trois livres au moins). Borné quelle que soit la
 * bibliothèque : au plus `maxRows` rangées de séries, d'auteurs et de genres, les plus fournies d'abord,
 * partagées entre les trois — les séries d'abord, puis les auteurs, puis les genres ; une sorte qui n'a
 * pas de quoi remplir sa part la laisse aux autres. Chacune réduite à `perRow` livres.
 */
/**
 * Lequel montrer de deux copies d'un même livre (`duplicateKey`) : celle où l'on a lu, puis celle qui a une
 * couverture, puis le titre le plus soigné (`titleCare`), puis la mieux décrite ; à égalité, toujours la
 * même (l'identifiant).
 */
export function preferredCopy(a: BookSummary, b: BookSummary): BookSummary {
  const read = (x: BookSummary) => (x.progress && x.progress.fraction > 0 ? 1 : 0);
  const order = [
    read(b) - read(a),
    (b.coverTag ? 1 : 0) - (a.coverTag ? 1 : 0),
    titleCare(b.name) - titleCare(a.name),
    (b.seriesName ? 1 : 0) + b.genres.length + (b.year ? 1 : 0) - ((a.seriesName ? 1 : 0) + a.genres.length + (a.year ? 1 : 0)),
  ];
  for (const d of order) if (d !== 0) return d > 0 ? b : a;
  return a.id <= b.id ? a : b;
}

/**
 * Le même livre en plusieurs copies — deux racines (`/livres` et un dossier de lots), ou deux fichiers
 * d'un même lot (« Les cavernes d acier » et « Les cavernes d'acier ») — n'apparaît qu'une fois. Les
 * fichiers restent sur le disque (un lot partagé les redemanderait) ; la copie montrée est
 * `preferredCopy`. L'index le fait pour toute la bibliothèque (`bookIndex.ts`) ; ici, pour une liste.
 */
export function dedupeBooks(books: readonly BookSummary[]): BookSummary[] {
  const best = new Map<string, BookSummary>();
  for (const b of books) {
    const key = duplicateKey(b);
    const held = best.get(key);
    best.set(key, held ? preferredCopy(held, b) : b);
  }
  const kept = new Set(best.values());
  return books.filter((b) => kept.has(b));
}

export function homeRows(input: readonly BookSummary[], { maxRows = 10, perRow = 20, deduped = false } = {}): HomeRows {
  // `deduped` : déjà dédoublonnés par l'appelant (l'index le fait à part, pour rendre la main à la boucle entre deux).
  const books = deduped ? (input as BookSummary[]) : dedupeBooks(input);
  const largest = <T extends { books: BookSummary[] }>(xs: T[]) => [...xs].sort((a, b) => b.books.length - a.books.length);

  const series = largest(groupBooks(books).filter((g) => g.series !== null && g.books.length >= 2));
  const authors = largest([...authorIndex(books).entries()].map(([key, v]) => ({ key, ...v })).filter((a) => a.books.length >= 2));
  const genres = largest([...genreIndex(books).entries()].map(([key, v]) => ({ key, ...v })).filter((g) => g.books.length >= 3));

  // Les parts : moitié aux séries, puis aux auteurs, le reste aux genres ; ce qui n'est pas pris passe aux suivants.
  const share = { series: Math.ceil(maxRows * 0.4), author: Math.ceil(maxRows * 0.3) };
  const pickedSeries = series.slice(0, share.series);
  const shownSeries = new Set(pickedSeries.map((g) => g.key));
  const usefulAuthors = authors.filter((a) => {
    const keys = new Set(a.books.map((b) => (b.seriesName ? `s:${fold(b.seriesName)}` : "-")));
    return !(keys.size === 1 && shownSeries.has([...keys][0]));
  });
  const pickedAuthors = usefulAuthors.slice(0, share.author + Math.max(0, share.series - pickedSeries.length));
  const pickedGenres = genres.slice(0, Math.max(0, maxRows - pickedSeries.length - pickedAuthors.length));
  // Des genres en manque : leur place revient aux séries puis aux auteurs restants.
  let spare = maxRows - pickedSeries.length - pickedAuthors.length - pickedGenres.length;
  const moreSeries = series.slice(pickedSeries.length, pickedSeries.length + Math.max(0, spare));
  spare -= moreSeries.length;
  const moreAuthors = usefulAuthors.slice(pickedAuthors.length, pickedAuthors.length + Math.max(0, spare));

  const rows: HomeRow[] = [
    ...[...pickedSeries, ...moreSeries].map((g) => ({
      key: g.key,
      kind: "series" as const,
      title: g.series as string,
      filter: { param: "serie" as const, value: g.series as string },
      total: g.books.length,
      books: g.books.slice(0, perRow),
    })),
    ...[...pickedAuthors, ...moreAuthors].map((a) => ({
      key: `a:${a.key}`,
      kind: "author" as const,
      title: a.label,
      filter: { param: "auteur" as const, value: a.label },
      total: a.books.length,
      books: [...a.books].sort(byYear).slice(0, perRow),
    })),
    ...pickedGenres.map((g) => ({
      key: `g:${g.key}`,
      kind: "genre" as const,
      title: g.label,
      filter: { param: "genre" as const, value: g.label },
      total: g.books.length,
      books: [...g.books].sort(byNewest).slice(0, perRow),
    })),
  ];
  const recent = [...books].filter((b) => b.addedAt !== null).sort(byNewest).slice(0, perRow);
  return {
    resume: continueReading(books),
    recent,
    rows,
    hidden: series.length + usefulAuthors.length + genres.length - rows.length,
  };
}

/** Sans accents ni casse : « Dérive » se trouve en tapant « derive ». */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

export type BookSort = "series" | "title" | "author" | "recent" | "year";
export const BOOK_SORTS: readonly BookSort[] = ["series", "title", "author", "recent", "year"];

export interface BookFilters {
  query?: string;
  serie?: string | null;
  auteur?: string | null;
  genre?: string | null;
}

/**
 * La grille filtrée : par série (`serie`, dont `NO_SERIES`), par auteur (dans n'importe quel ordre des
 * mots), par genre, puis par les mots tapés — chacun doit se trouver dans le titre, la série ou un auteur.
 */
export function filterBooks(books: readonly BookSummary[], query: string | BookFilters, serie: string | null = null): BookSummary[] {
  const f: BookFilters = typeof query === "string" ? { query, serie } : query;
  let out = books as BookSummary[];
  if (f.serie === NO_SERIES) out = out.filter((b) => !b.seriesName);
  else if (f.serie) {
    const key = fold(f.serie);
    out = out.filter((b) => b.seriesName && fold(b.seriesName) === key);
  }
  if (f.auteur) {
    const key = nameKey(f.auteur);
    out = out.filter((b) => b.authors.some((a) => nameKey(a) === key));
  }
  if (f.genre) {
    const key = fold(f.genre);
    out = out.filter((b) => b.genres.some((g) => fold(g) === key));
  }
  const words = foldText(f.query ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return out;
  return out.filter((b) => {
    const hay = foldText([b.name, b.seriesName ?? "", ...b.authors].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Un tri de la grille ; `series` garde l'ordre du serveur (séries, tomes), les autres donnent une grille à plat. */
export function sortBooks(books: readonly BookSummary[], sort: BookSort): BookSummary[] {
  const list = [...books];
  switch (sort) {
    case "series":
      return list;
    case "title":
      return list.sort((a, b) => collator.compare(a.name, b.name));
    case "author":
      return list.sort((a, b) => collator.compare(lastName(a.authors[0] ?? "~"), lastName(b.authors[0] ?? "~")) || collator.compare(a.name, b.name));
    case "recent":
      return list.sort(byNewest);
    case "year":
      return list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || collator.compare(a.name, b.name));
  }
}

/** Le mot sous lequel ranger un auteur : le dernier (« Guillaume Musso » → « Musso »). */
function lastName(name: string): string {
  const words = name.trim().split(/\s+/);
  return words[words.length - 1] ?? name;
}
