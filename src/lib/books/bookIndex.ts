import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import type { BookCaller, LibraryItem } from "@/lib/books/library";
import { compareBooks, fetchLibrary, summaryOf } from "@/lib/books/library";
import { knownMeta, metaVersion, scheduleMetaReads, staleMeta } from "@/lib/books/epubMeta";
import { allows, rightsKey, rightsOf, type BookRights } from "@/lib/books/rights";
import { authorIndex, dedupeBooks, filterBooks, foldText, genreIndex, groupBooks, homeRows, sortBooks, type BookSort, type HomeRows } from "@/lib/books/grouping";
import type { BookProgress, BookSummary } from "@/lib/books/types";

/**
 * L'index des livres, **un seul pour tous les comptes**, en mémoire (DECISIONS.md §127).
 *
 * Une bibliothèque de plusieurs milliers d'EPUB ne voyage jamais entière jusqu'au téléphone : le serveur
 * la garde ici, triée, avec le texte de recherche de chaque livre déjà replié. Les routes n'en envoient
 * que des morceaux — l'accueil (quelques rangées), une page de la grille, douze résultats de recherche.
 *
 * La bibliothèque est lue une fois, avec la clé du serveur (`fetchLibrary`) : en production, sept pages de
 * mille livres coûtaient ~5 s **à chaque compte** après chaque redémarrage. Chaque compte n'en voit que ce
 * que ses droits permettent (`rights.ts` : ses bibliothèques Jellyfin, ses tags bloqués, la classification) ;
 * la vue d'un ensemble de droits (livres, accueil, choix des menus) est calculée une fois et partagée par
 * les comptes qui ont les mêmes droits (au plus vingt-quatre vues gardées).
 *
 * Rien n'est lu au lancement : l'index naît à la première ouverture de la catégorie Livres. Une copie des
 * éléments reçus est gardée sur le disque (`DATA_DIR/book-index.json`, un jour au plus) : après un
 * redémarrage, la première ouverture part d'elle pendant que Jellyfin est relu derrière. Frais cinq
 * minutes ; au-delà, la réponse part de l'index gardé pendant qu'un autre se prépare (une préparation à
 * la fois). Quand des métadonnées d'EPUB arrivent (`epubMeta.ts`), l'index se refait depuis les éléments
 * déjà reçus, au plus toutes les vingt secondes. La construction rend la main à la boucle tous les
 * quelques centaines de livres. Ce qui est propre à un compte — position, « lu » chez Jellyfin — est posé
 * sur les livres envoyés au moment de répondre (`withProgress`).
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

/** Un livre de l'index commun, avec ce que les droits lisent. */
interface Entry {
  book: BookSummary;
  hay: string;
  library: string;
  tags: string[];
  rated: boolean;
}

interface Base {
  builtAt: number;
  entries: Entry[];
}

interface Shared {
  items: LibraryItem[] | null;
  fetchedAt: number;
  metaVersion: number;
  base: Base | null;
  pending: Promise<Base> | null;
  diskTried: boolean;
  views: Map<string, { baseAt: number; view: BookIndex; usedAt: number }>;
  viewPending: Map<string, Promise<BookIndex>>;
}

const FRESH_MS = 5 * 60_000;
const META_REBUILD_MS = 20_000;
const MAX_VIEWS = 24;
const YIELD_EVERY = 400;
const DISK_MAX_AGE_MS = 24 * 3600_000;
const diskFile = () => path.join(DATA_DIR, "book-index.json");

const KEY = Symbol.for("laterna.books.sharedIndex");
function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>;
  return (g[KEY] ??= { items: null, fetchedAt: 0, metaVersion: -1, base: null, pending: null, diskTried: false, views: new Map(), viewPending: new Map() });
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** L'index commun fait d'une liste d'éléments — par tranches, la boucle reprend la main entre deux. */
async function buildBase(items: readonly LibraryItem[]): Promise<Base> {
  const known = knownMeta();
  const entries: Entry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const book = summaryOf(item, known.get(item.Id.toLowerCase())?.meta ?? null);
    entries.push({
      book,
      hay: foldText(`${book.name} ${book.seriesName ?? ""} ${book.authors.join(" ")}`),
      library: item.library,
      tags: item.Tags ?? [],
      rated: !!item.OfficialRating,
    });
    if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToLoop();
  }
  entries.sort((a, b) => compareBooks(a.book, b.book));
  await yieldToLoop();
  // Les OPF pas encore lus partent en arrière-plan ; cet index-ci fait sans.
  scheduleMetaReads(staleMeta(entries.map((e) => ({ id: e.book.id, etag: e.book.fileTag })), known));
  return { builtAt: Date.now(), entries };
}

/** La vue d'un ensemble de droits : les livres permis, l'accueil, les choix des menus. */
async function buildView(base: Base, rights: BookRights): Promise<BookIndex> {
  const books: BookSummary[] = [];
  const hay: string[] = [];
  for (let i = 0; i < base.entries.length; i++) {
    const e = base.entries[i];
    if (allows(rights, e)) {
      books.push(e.book);
      hay.push(e.hay);
    }
    if (i % (YIELD_EVERY * 4) === YIELD_EVERY * 4 - 1) await yieldToLoop();
  }
  await yieldToLoop();
  // Le dédoublonnage d'abord, la boucle reprenant la main avant les rangées : à 6 400 livres, les deux d'un bloc
  // tenaient la boucle ~30 ms (le double sous charge).
  const deduped = dedupeBooks(books);
  await yieldToLoop();
  const computed = homeRows(deduped, { deduped: true });
  const home = { recent: computed.recent, rows: computed.rows, hidden: computed.hidden };
  await yieldToLoop();
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort(collator.compare);
  // Les trois listes l'une après l'autre, la boucle reprenant la main entre deux.
  const genres = sorted([...genreIndex(books).values()].filter((g) => g.books.length >= 2).map((g) => g.label));
  await yieldToLoop();
  const series = sorted(groupBooks(books).flatMap((g) => (g.series ? [g.series] : [])));
  await yieldToLoop();
  const authors = sorted([...authorIndex(books).values()].map((a) => a.label));
  const facets = { series, authors, genres };
  return { builtAt: Date.now(), books, byId: new Map(books.map((b) => [b.id, b])), hay, home, facets };
}

/** Pour les tests et les mesures : l'index d'une liste, vu avec tous les droits. */
export async function buildIndex(items: readonly LibraryItem[], rights: BookRights = { folders: null, tags: [], blockUnrated: false, blockRated: false }): Promise<BookIndex> {
  return buildView(await buildBase(items), rights);
}

async function readDisk(): Promise<{ savedAt: number; items: LibraryItem[] } | null> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(diskFile(), "utf8")) as { savedAt?: number; items?: LibraryItem[] };
    if (typeof raw.savedAt !== "number" || !Array.isArray(raw.items) || Date.now() - raw.savedAt > DISK_MAX_AGE_MS) return null;
    return { savedAt: raw.savedAt, items: raw.items };
  } catch {
    return null;
  }
}

function writeDisk(items: LibraryItem[]): void {
  const tmp = `${diskFile()}.${process.pid}.tmp`;
  void fs.promises
    .writeFile(tmp, JSON.stringify({ savedAt: Date.now(), items }))
    .then(() => fs.promises.rename(tmp, diskFile()))
    .catch(() => fs.promises.rm(tmp, { force: true }).catch(() => {}));
}

function refresh(s: Shared, refetch: boolean): Promise<Base> {
  s.pending ??= (async () => {
    try {
      if (!s.items || refetch) {
        s.items = await fetchLibrary();
        s.fetchedAt = Date.now();
        writeDisk(s.items);
      }
      s.metaVersion = metaVersion();
      s.base = await buildBase(s.items);
      return s.base;
    } finally {
      s.pending = null;
    }
  })();
  return s.pending;
}

/** L'index commun : attendu la première fois seulement ; ensuite servi tel quel, refait derrière s'il a vieilli. */
async function sharedBase(now = Date.now()): Promise<Base> {
  const s = shared();
  if (!s.base && !s.diskTried) {
    s.diskTried = true;
    const disk = await readDisk();
    if (disk && !s.base) {
      s.items = disk.items;
      s.fetchedAt = disk.savedAt;
      s.metaVersion = metaVersion();
      s.base = await buildBase(disk.items);
    }
  }
  if (!s.base) return refresh(s, true);
  const stale = now - s.fetchedAt >= FRESH_MS;
  const metaMoved = s.metaVersion !== metaVersion() && now - s.base.builtAt >= META_REBUILD_MS;
  if ((stale || metaMoved) && !s.pending) {
    refresh(s, stale).catch(() => {
      // L'index gardé reste servi ; la prochaine demande retentera.
    });
  }
  return s.base;
}

/** Ce que ce compte voit de l'index commun. Lève si ses droits ne peuvent pas être lus (la route dit 502). */
export async function bookIndex(caller: BookCaller, now = Date.now()): Promise<BookIndex> {
  const [base, rights] = await Promise.all([sharedBase(now), rightsOf(caller, now)]);
  const s = shared();
  const key = rightsKey(rights);
  const held = s.views.get(key);
  if (held && held.baseAt === base.builtAt) {
    held.usedAt = now;
    return held.view;
  }
  const pendingKey = `${key}@${base.builtAt}`;
  let job = s.viewPending.get(pendingKey);
  if (!job) {
    job = buildView(base, rights).finally(() => s.viewPending.delete(pendingKey));
    s.viewPending.set(pendingKey, job);
  }
  const view = await job;
  s.views.set(key, { baseAt: base.builtAt, view, usedAt: now });
  if (s.views.size > MAX_VIEWS) {
    const oldest = [...s.views.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    s.views.delete(oldest[0]);
  }
  return view;
}

/**
 * Ce qui est propre à ce compte, posé sur des livres de l'index (copies : l'index est partagé) — sa
 * position de lecture, et « lu » selon Jellyfin.
 */
export function withProgress(books: readonly BookSummary[], progress: Map<string, BookProgress>, played: ReadonlySet<string> = EMPTY_SET): BookSummary[] {
  return books.map((b) => {
    const p = progress.get(b.id);
    const isPlayed = played.has(b.id);
    return p || isPlayed ? { ...b, progress: p ?? b.progress, played: isPlayed || b.played } : b;
  });
}
const EMPTY_SET: ReadonlySet<string> = new Set();

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

export const __testing = {
  reset: () => {
    const s = shared();
    Object.assign(s, { items: null, fetchedAt: 0, metaVersion: -1, base: null, pending: null, diskTried: true });
    s.views.clear();
    s.viewPending.clear();
  },
  shared,
  diskFile,
};
