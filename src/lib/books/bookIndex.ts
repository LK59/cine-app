import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import type { BookCaller, LibraryItem } from "@/lib/books/library";
import { booksWithoutOverview, compareBooks, fetchLibrary, summaryOf } from "@/lib/books/library";
import { knownMeta, metaVersion as epubMetaVersion, scheduleMetaReads, staleMeta } from "@/lib/books/epubMeta";
import { enrichVersion, knownEnrich, type EnrichTarget } from "@/lib/books/googleBooks";

import { allows, rightsKey, rightsOf, type BookRights } from "@/lib/books/rights";
import { authorIndex, filterBooks, foldText, genreIndex, groupBooks, homeRows, preferredCopy, sortBooks, type BookSort, type HomeRows } from "@/lib/books/grouping";
import { duplicateKey, nameKey, titleKey } from "@/lib/books/metadata";
import type { BookProgress, BookSummary } from "@/lib/books/types";

/** Les métadonnées qui refont l'index : celles de l'EPUB, et celles de Google Books (option). */
const metaVersion = () => epubMetaVersion() * 1_000_000 + enrichVersion();

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
  /** Les livres montrés : une copie par livre (`duplicateKey`, `preferredCopy`). */
  books: BookSummary[];
  byId: Map<string, BookSummary>;
  /** Tous les livres permis, copies cachées comprises : une position ou un lien direct les ouvre encore. */
  all: Map<string, BookSummary>;
  /** Une copie cachée → celle montrée à sa place. */
  hiddenTo: Map<string, string>;
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
  /** L'ISBN que Jellyfin connaît, pour Google Books (option). */
  isbn: string | null;
  /** L'EPUB déclare-t-il une couverture ? `null` : pas encore lu. */
  epubCover: boolean | null;
  /**
   * La langue du livre : celle que l'EPUB déclare (`dc:language`), sinon celle des métadonnées de sa
   * bibliothèque ; `null` : ni l'une ni l'autre (Google Books prend alors la langue de l'installation).
   */
  language: string | null;
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
  const enriched = knownEnrich();
  const entries: Entry[] = [];
  const unreadable: { id: string; etag: string | null }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = item.Id.toLowerCase();
    const k = known.get(id);
    const book = summaryOf(item, k?.meta ?? null, enriched.get(id) ?? null);
    // Un EPUB illisible (zip tronqué, pas d'OPF) n'est montré nulle part tant que ce fichier-là reste :
    // il restait dans les grilles, s'ouvrait sur une erreur, et sa couverture était redemandée à chaque
    // affichage. Le fichier n'est pas touché (un lot partagé le redemanderait) ; remplacé, il revient.
    if (k?.defect && k.etag === book.fileTag) {
      unreadable.push({ id: book.id, etag: book.fileTag });
      continue;
    }
    const providers = item.ProviderIds ?? {};
    const isbn = Object.entries(providers).find(([key]) => /^isbn/i.test(key))?.[1] ?? null;
    entries.push({
      isbn,
      epubCover: k ? (k.meta ? !!k.meta.coverPath : false) : null,
      language: k?.meta?.language ?? item.libraryLanguage ?? null,
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
  scheduleMetaReads(staleMeta([...entries.map((e) => ({ id: e.book.id, etag: e.book.fileTag })), ...unreadable], known));
  return { builtAt: Date.now(), entries };
}

/**
 * La vue d'un ensemble de droits : les livres permis — une copie par livre —, l'accueil, les choix des
 * menus. Les copies d'un même livre (un lot qui contient deux fois « Les cavernes d'acier », deux racines)
 * restent sur le disque — un lot partagé les redemanderait — et dans `all` ; seule la meilleure est
 * montrée partout (rangées, pages, nombres, menus, recherche). Dédoublonnées **après** les droits : la
 * copie qu'un compte voit est montrée même si l'autre lui est interdite.
 */
async function buildView(base: Base, rights: BookRights): Promise<BookIndex> {
  const permitted: Entry[] = [];
  for (let i = 0; i < base.entries.length; i++) {
    const e = base.entries[i];
    if (allows(rights, e)) permitted.push(e);
    if (i % (YIELD_EVERY * 4) === YIELD_EVERY * 4 - 1) await yieldToLoop();
  }
  await yieldToLoop();
  // Une copie par livre — la boucle reprenant la main avant les rangées : à 6 400 livres, dédoublonner
  // et calculer les rangées d'un bloc la tenaient ~30 ms (le double sous charge).
  const best = new Map<string, BookSummary>();
  for (let i = 0; i < permitted.length; i++) {
    const book = permitted[i].book;
    const key = duplicateKey(book);
    const held = best.get(key);
    best.set(key, held ? preferredCopy(held, book) : book);
    if (i % (YIELD_EVERY * 2) === YIELD_EVERY * 2 - 1) await yieldToLoop();
  }
  const shown = new Set(best.values());
  const books: BookSummary[] = [];
  const hay: string[] = [];
  const all = new Map<string, BookSummary>();
  const hiddenTo = new Map<string, string>();
  for (const e of permitted) {
    all.set(e.book.id, e.book);
    if (shown.has(e.book)) {
      books.push(e.book);
      hay.push(e.hay);
    } else {
      const kept = best.get(duplicateKey(e.book));
      if (kept) hiddenTo.set(e.book.id, kept.id);
    }
  }
  await yieldToLoop();
  const computed = homeRows(books, { deduped: true });
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
  return { builtAt: Date.now(), books, byId: new Map(books.map((b) => [b.id, b])), all, hiddenTo, home, facets, hay };
}

/** Pour les tests et les mesures : l'index d'une liste, vu avec tous les droits. */
export async function buildIndex(items: readonly LibraryItem[], rights: BookRights = { folders: null, tags: [], allowed: [], blockUnrated: false, blockRated: false }): Promise<BookIndex> {
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

/**
 * Ce que ce compte voit de l'index commun. Lève si ses droits ne peuvent pas être lus (la route dit 502).
 * La vue de ses droits est servie telle qu'elle est quand l'index commun vient d'être refait : la neuve
 * se calcule derrière (un filtre de l'index, quelques dizaines de millisecondes rendues à la boucle par
 * tranches) et sert la demande suivante. Seule la toute première vue d'un ensemble de droits est attendue.
 */
export async function bookIndex(caller: BookCaller, now = Date.now()): Promise<BookIndex> {
  const [base, rights] = await Promise.all([sharedBase(now), rightsOf(caller, now)]);
  const s = shared();
  const key = rightsKey(rights);
  const held = s.views.get(key);
  if (held) held.usedAt = now;
  if (held && held.baseAt === base.builtAt) return held.view;
  const pendingKey = `${key}@${base.builtAt}`;
  let job = s.viewPending.get(pendingKey);
  if (!job) {
    job = buildView(base, rights)
      .then((view) => {
        s.views.set(key, { baseAt: base.builtAt, view, usedAt: Date.now() });
        if (s.views.size > MAX_VIEWS) {
          const oldest = [...s.views.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
          s.views.delete(oldest[0]);
        }
        return view;
      })
      .finally(() => s.viewPending.delete(pendingKey));
    s.viewPending.set(pendingKey, job);
  }
  if (held) {
    job.catch(() => {});
    return held.view;
  }
  return job;
}

/** Le préchauffage (`prewarm.ts`) : l'index commun construit, et la vue « tous droits » avec lui. Rend le nombre de livres. */
export async function warmSharedIndex(): Promise<number> {
  const base = await sharedBase();
  const view = await bookIndex({ role: "admin", jfId: undefined });
  return view.books.length || base.entries.length;
}

/**
 * Les livres que Google Books (option, `googleBooks.ts`) pourrait compléter, et ce qui leur manque —
 * vus de toute la bibliothèque, sans droits de compte : ce qui est trouvé n'est montré qu'à qui voit le
 * livre. Les copies d'un même livre comptent chacune (l'une peut avoir un résumé, l'autre non).
 */
export async function enrichTargets(): Promise<EnrichTarget[]> {
  const base = await sharedBase();
  const noOverview = await booksWithoutOverview();
  // Les titres de chaque auteur : un résumé qui parle d'un autre de ses livres et pas du nôtre est refusé.
  const byAuthor = new Map<string, string[]>();
  for (const e of base.entries) {
    const key = nameKey(e.book.authors[0] ?? "");
    if (!key) continue;
    const list = byAuthor.get(key) ?? [];
    list.push(e.book.name);
    byAuthor.set(key, list);
  }
  return base.entries.map((e) => ({
    id: e.book.id,
    name: e.book.name,
    authors: e.book.authors,
    isbn: e.isbn,
    language: e.language,
    series: e.book.seriesName,
    index: e.book.index,
    siblings: (byAuthor.get(nameKey(e.book.authors[0] ?? "")) ?? []).filter((t) => titleKey(t) !== titleKey(e.book.name)).slice(0, 80),
    needs: {
      overview: noOverview.has(e.book.id),
      // La couverture seulement quand ni Jellyfin ni l'EPUB n'en ont — et l'EPUB déjà lu.
      cover: !e.book.coverTag && e.epubCover === false,
      genres: e.book.genres.length === 0,
      year: e.book.year === null,
    },
  }));
}

/** Le garder chaud : le redemander suffit — vieilli, il se refait derrière. */
export async function keepSharedIndexWarm(): Promise<void> {
  await sharedBase();
}

/**
 * Les copies cachées que ce compte a commencées ou marquées : chez lui, c'est elle qui est montrée à la
 * place de l'autre — sa position et ses signets la suivent.
 */
export function accountCopies(index: BookIndex, ids: Iterable<string>): Map<string, BookSummary> {
  const swap = new Map<string, BookSummary>();
  for (const id of ids) {
    const shownId = index.hiddenTo.get(id);
    const twin = index.all.get(id);
    if (shownId && twin) swap.set(shownId, twin);
  }
  return swap;
}

/**
 * Ce qui est propre à ce compte, posé sur des livres de l'index (copies : l'index est partagé) — sa
 * position de lecture, et « lu » selon Jellyfin.
 */
export function withProgress(
  books: readonly BookSummary[],
  progress: Map<string, BookProgress>,
  played: ReadonlySet<string> = EMPTY_SET,
  copies: ReadonlyMap<string, BookSummary> = EMPTY_COPIES
): BookSummary[] {
  return books.map((shown) => {
    const b = copies.get(shown.id) ?? shown;
    const p = progress.get(b.id);
    const isPlayed = played.has(b.id);
    return p || isPlayed ? { ...b, progress: p ?? b.progress, played: isPlayed || b.played } : b;
  });
}
const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_COPIES: ReadonlyMap<string, BookSummary> = new Map();

/** « Continuer la lecture » : d'après les positions de ce compte, les livres que l'index connaît encore. */
export function resumeFrom(index: BookIndex, progress: Map<string, BookProgress>, limit = 12): BookSummary[] {
  return [...progress.entries()]
    // Une position gardée est un livre commencé (29/10/2026 : dès la deuxième page) ; la page d'ouverture n'en
    // laisse aucune (`forgetUnstarted`).
    .filter(([, p]) => !p.finished && !p.dismissed)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .flatMap(([id, p]) => {
      // Une copie cachée commencée reste ici : c'est elle qu'on lisait.
      const book = index.all.get(id);
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
