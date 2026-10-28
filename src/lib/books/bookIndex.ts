import type { BookCaller, JellyfinBookItem } from "@/lib/books/library";
import { compareBooks, fetchBookItems, summaryOf } from "@/lib/books/library";
import { knownMeta, metaVersion, scheduleMetaReads, staleMeta } from "@/lib/books/epubMeta";
import { authorIndex, filterBooks, foldText, genreIndex, groupBooks, homeRows, sortBooks, type BookSort, type HomeRows } from "@/lib/books/grouping";
import type { BookProgress, BookSummary } from "@/lib/books/types";

/**
 * L'index des livres, par compte, en mémoire (DECISIONS.md §127).
 *
 * Une bibliothèque de plusieurs milliers d'EPUB ne voyage jamais entière jusqu'au téléphone : le serveur
 * la garde ici, triée, avec le texte de recherche de chaque livre déjà replié, l'accueil (`homeRows`)
 * déjà calculé et les choix des filtres de la grille. Les routes n'en envoient que des morceaux —
 * l'accueil (quelques rangées), une page de la grille, douze résultats de recherche.
 *
 * Rien n'est lu au lancement : l'index d'un compte naît à sa première ouverture de la catégorie Livres.
 * Frais cinq minutes ; au-delà, la réponse part de l'index gardé pendant qu'un autre se prépare derrière
 * (une seule préparation à la fois par compte). Les métadonnées des EPUB arrivent en arrière-plan
 * (`epubMeta.ts`) : quand un lot est écrit, l'index se refait depuis les éléments déjà reçus, sans
 * redemander Jellyfin, au plus toutes les vingt secondes. La construction rend la main à la boucle tous
 * les quelques centaines de livres. Les positions de lecture n'y sont pas : elles sont par compte, en
 * base, et posées sur les livres envoyés au moment de répondre (`withProgress`).
 *
 * Sur `globalThis`, comme le cache serveur : les routes sont des points d'entrée distincts.
 */

export interface BookIndex {
  builtAt: number;
  books: BookSummary[];
  byId: Map<string, BookSummary>;
  /** Le titre, la série et les auteurs, repliés (`foldText`), dans l'ordre de `books`. */
  hay: string[];
  home: Omit<HomeRows, "resume">;
  facets: { series: string[]; authors: string[]; genres: string[] };
}

interface Entry {
  items: JellyfinBookItem[] | null;
  fetchedAt: number;
  metaVersion: number;
  index: BookIndex | null;
  pending: Promise<BookIndex> | null;
  usedAt: number;
}

const FRESH_MS = 5 * 60_000;
const META_REBUILD_MS = 20_000;
const MAX_ACCOUNTS = 24;
const YIELD_EVERY = 400;

const KEY = Symbol.for("laterna.books.index");
function entries(): Map<string, Entry> {
  const g = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
  return (g[KEY] ??= new Map());
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** L'index fait d'une liste d'éléments de Jellyfin — par tranches, la boucle reprend la main entre deux. */
export async function buildIndex(items: readonly JellyfinBookItem[]): Promise<BookIndex> {
  const known = knownMeta();
  const books: BookSummary[] = [];
  for (let i = 0; i < items.length; i++) {
    books.push(summaryOf(items[i], known.get(items[i].Id.toLowerCase())?.meta ?? null));
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToLoop();
  }
  books.sort(compareBooks);
  await yieldToLoop();
  const hay: string[] = [];
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    hay.push(foldText(`${b.name} ${b.seriesName ?? ""} ${b.authors.join(" ")}`));
    if (i % (YIELD_EVERY * 4) === YIELD_EVERY * 4 - 1) await yieldToLoop();
  }
  await yieldToLoop();
  const computed = homeRows(books);
  const home = { recent: computed.recent, rows: computed.rows, hidden: computed.hidden };
  await yieldToLoop();
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort(collator.compare);
  const genres = [...genreIndex(books).values()].filter((g) => g.books.length >= 2).map((g) => g.label);
  const facets = {
    series: sorted(groupBooks(books).flatMap((g) => (g.series ? [g.series] : []))),
    authors: sorted([...authorIndex(books).values()].map((a) => a.label)),
    genres: sorted(genres),
  };
  // Les OPF pas encore lus partent en arrière-plan ; cet index-ci fait sans.
  scheduleMetaReads(staleMeta(books.map((b) => ({ id: b.id, etag: b.fileTag })), known));
  return { builtAt: Date.now(), books, byId: new Map(books.map((b) => [b.id, b])), hay, home, facets };
}

function accountKey(caller: BookCaller): string {
  return caller.jfId ? caller.jfId.toLowerCase() : "*local";
}

function evict(map: Map<string, Entry>): void {
  if (map.size <= MAX_ACCOUNTS) return;
  const oldest = [...map.entries()].filter(([, e]) => !e.pending).sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [key] of oldest.slice(0, map.size - MAX_ACCOUNTS)) map.delete(key);
}

function refresh(caller: BookCaller, entry: Entry): Promise<BookIndex> {
  entry.pending ??= (async () => {
    try {
      const now = Date.now();
      if (!entry.items || now - entry.fetchedAt >= FRESH_MS) {
        entry.items = await fetchBookItems(caller);
        entry.fetchedAt = Date.now();
      }
      entry.metaVersion = metaVersion();
      entry.index = await buildIndex(entry.items);
      return entry.index;
    } finally {
      entry.pending = null;
    }
  })();
  return entry.pending;
}

/**
 * L'index de ce compte. Attendu seulement la première fois ; ensuite, toujours celui qu'on a, et un
 * neuf qui se prépare derrière quand il a vieilli ou que des métadonnées sont arrivées.
 */
export async function bookIndex(caller: BookCaller, now = Date.now()): Promise<BookIndex> {
  const map = entries();
  const key = accountKey(caller);
  let entry = map.get(key);
  if (!entry) {
    entry = { items: null, fetchedAt: 0, metaVersion: -1, index: null, pending: null, usedAt: now };
    map.set(key, entry);
    evict(map);
  }
  entry.usedAt = now;
  if (!entry.index) return refresh(caller, entry);
  const stale = now - entry.fetchedAt >= FRESH_MS;
  const metaMoved = entry.metaVersion !== metaVersion() && now - entry.index.builtAt >= META_REBUILD_MS;
  if ((stale || metaMoved) && !entry.pending) {
    refresh(caller, entry).catch(() => {
      // L'index gardé reste servi ; la prochaine demande retentera.
    });
  }
  return entry.index;
}

/** Les positions de lecture de ce compte, posées sur des livres de l'index (copies : l'index est partagé). */
export function withProgress(books: readonly BookSummary[], progress: Map<string, BookProgress>): BookSummary[] {
  return books.map((b) => {
    const p = progress.get(b.id);
    return p ? { ...b, progress: p } : b;
  });
}

/** « Continuer la lecture » : d'après les positions de ce compte, les livres que l'index connaît encore. */
export function resumeFrom(index: BookIndex, progress: Map<string, BookProgress>, limit = 12): BookSummary[] {
  return [...progress.entries()]
    .filter(([, p]) => !p.finished && p.fraction > 0)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .flatMap(([id, p]) => {
      const book = index.byId.get(id);
      return book ? [{ ...book, progress: p }] : [];
    })
    .slice(0, limit);
}

export interface PageQuery {
  query?: string;
  serie?: string | null;
  auteur?: string | null;
  genre?: string | null;
  tri?: BookSort;
  offset?: number;
  limit?: number;
}

export const PAGE_MAX = 200;

/** Une page de la grille filtrée et triée ; `total` : combien en tout. */
export function pageOf(index: BookIndex, q: PageQuery): { total: number; books: BookSummary[]; seriesCounts: Record<string, number> } {
  let list = filterBooks(index.books, { serie: q.serie ?? null, auteur: q.auteur ?? null, genre: q.genre ?? null });
  const words = foldText(q.query ?? "").split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const keep = new Set(index.books.filter((_, i) => words.every((w) => index.hay[i].includes(w))));
    list = list.filter((b) => keep.has(b));
  }
  const sorted = sortBooks(list, q.tri ?? "series");
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(q.limit ?? 120)));
  const books = sorted.slice(offset, offset + limit);
  // Le nombre de tomes de chaque série de la page, sur toute la grille filtrée : l'en-tête d'une série
  // coupée entre deux pages dit le vrai compte.
  const seriesCounts: Record<string, number> = {};
  const wanted = new Set(books.flatMap((b) => (b.seriesName ? [b.seriesName] : [])));
  if (wanted.size > 0) for (const b of sorted) if (b.seriesName && wanted.has(b.seriesName)) seriesCounts[b.seriesName] = (seriesCounts[b.seriesName] ?? 0) + 1;
  return { total: sorted.length, books, seriesCounts };
}

/** La recherche de l'application : les livres dont le titre, la série ou un auteur contient chaque mot tapé. */
export function searchIndex(index: BookIndex, query: string, limit = 12): BookSummary[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const first = words.join(" ");
  const scored: { book: BookSummary; score: number }[] = [];
  for (let i = 0; i < index.books.length; i++) {
    const hay = index.hay[i];
    if (!words.every((w) => hay.includes(w))) continue;
    const title = foldText(index.books[i].name);
    // Le titre qui commence par ce qu'on tape d'abord, puis le titre qui le contient, puis le reste.
    const score = title.startsWith(first) ? 3 : title.includes(first) ? 2 : 1;
    scored.push({ book: index.books[i], score });
  }
  return scored
    .sort((a, b) => b.score - a.score || collator.compare(a.book.name, b.book.name))
    .slice(0, limit)
    .map((s) => s.book);
}

export const __testing = { reset: () => entries().clear(), entries };
