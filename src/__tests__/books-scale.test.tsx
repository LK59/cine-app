// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Les livres à l'échelle d'une grande bibliothèque (DECISIONS.md §127) : plusieurs milliers d'EPUB, et
 * jamais rien qui ralentisse le reste de l'application. La liste est demandée à Jellyfin par pages et
 * sans résumés ; l'index du compte se construit par tranches, la boucle d'évènements reprenant la main
 * entre deux ; l'accueil reste borné ; la grille demande ses pages à l'approche du bas ; la recherche
 * trouve par titre, série ou auteur.
 */
// Une base à soi (le cache des OPF y est lu) : celle du dossier commun est ouverte par d'autres fichiers.
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "laterna-books-scale-"));
});
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));
vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "k" } } }));
const upstream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: (...a: unknown[]) => upstream(...a), passJellyfinFetch: (...a: unknown[]) => upstream(...a) }));
vi.mock("@/lib/blockedTags", () => ({ blockedTagsOf: async () => [], carriesBlockedTag: () => false }));

import { LIST_PAGE, fetchBookItems, type JellyfinBookItem } from "@/lib/books/library";
import { buildIndex, pageOf, searchIndex } from "@/lib/books/bookIndex";
import { __testing as metaTesting } from "@/lib/books/epubMeta";
import { NO_SERIES, filterBooks, homeRows } from "@/lib/books/grouping";
import { BooksGrid } from "@/components/books/BooksGrid";
import type { BookSummary } from "@/lib/books/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hex = (n: number) => n.toString(16).padStart(32, "0");

/** 5 000 livres : 400 séries de 10 tomes, et 1 000 sans série. */
function library(): BookSummary[] {
  const out: BookSummary[] = [];
  for (let i = 0; i < 5000; i++) {
    const inSeries = i < 4000;
    out.push({
      id: hex(i + 1),
      name: inSeries ? `Tome ${(i % 10) + 1} de la série ${Math.floor(i / 10)}` : `Roman isolé ${i}`,
      coverTag: `t${i}`,
      fileTag: null,
      seriesName: inSeries ? `Série ${String(Math.floor(i / 10)).padStart(3, "0")}` : null,
      index: inSeries ? (i % 10) + 1 : null,
      year: 2000 + (i % 25),
      authors: [i % 7 === 0 ? "Élodie Durand" : `Auteur ${i % 50}`],
      genres: [["Policier", "Thriller", "Jeunesse", "Science-fiction", "Fantasy"][i % 5]],
      addedAt: 1_700_000_000_000 + i * 1000,
      played: false,
      progress: i === 3321 ? { cfi: "epubcfi(/6/2)", fraction: 0.3, updatedAt: 5, finished: false } : null,
    });
  }
  return out;
}

/** 6 400 éléments comme Jellyfin les rend pour un gros lot d'EPUB : un auteur sur quatre absent, des genres bruts. */
function jellyfinItems(n = 6400): JellyfinBookItem[] {
  return Array.from({ length: n }, (_, i) => ({
    Id: hex(i + 1),
    Name: `Livre ${i}`,
    Type: "Book",
    ProductionYear: i % 13 ? 1950 + (i % 70) : null,
    ImageTags: (i % 3 ? { Primary: `p${i}` } : {}) as Record<string, string>,
    Genres: i % 2 ? [["Policier", "SF", "Science-Fiction", "Fantasy", "Fantastique", "Lang:fr"][(i >> 1) % 6]] : [],
    People: i % 4 ? [{ Name: `Auteur ${i % 1464}`, Type: "Author" }] : [],
    DateCreated: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    Etag: `e${i}`,
  }));
}

describe("la liste demandée à Jellyfin", () => {
  it("par pages, sans résumé, jusqu'au total annoncé", async () => {
    const total = 2500;
    upstream.mockImplementation(async (url: string) => {
      const params = new URL(url).searchParams;
      const start = Number(params.get("StartIndex"));
      const limit = Number(params.get("Limit"));
      const items = Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, k) => ({ Id: hex(start + k + 1), Name: `Livre ${start + k}`, Type: "Book", SeriesName: null }));
      return new Response(JSON.stringify({ Items: items, TotalRecordCount: total }), { status: 200 });
    });
    const items = await fetchBookItems({ role: "user", jfId: "a".repeat(32) });
    expect(items).toHaveLength(total);
    const urls = upstream.mock.calls.map(([u]) => new URL(u as string)).filter((u) => u.searchParams.has("StartIndex"));
    expect(urls).toHaveLength(Math.ceil(total / LIST_PAGE));
    expect(urls.map((u) => u.searchParams.get("StartIndex"))).toEqual(["0", "1000", "2000"]);
    for (const u of urls) {
      expect(u.searchParams.get("Fields")).not.toMatch(/Overview/);
      expect(u.searchParams.get("Limit")).toBe(String(LIST_PAGE));
    }
  });
});

describe("l'index d'un compte", () => {
  it("se construit sans tenir la boucle : mesuré sur 6 400 livres", async () => {
    // La file des OPF ne lit rien ici : on ne mesure que la construction.
    metaTesting.queue().playing = () => true;
    const items = jellyfinItems();
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    const t0 = performance.now();
    const index = await buildIndex(items);
    const total = performance.now() - t0;
    h.disable();
    const p99 = h.percentile(99) / 1e6;
    const max = h.max / 1e6;
    console.log(`[livres] index de ${items.length} livres : ${total.toFixed(0)} ms en tout, boucle p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
    expect(index.books).toHaveLength(6400);
    // Une borne large (les fichiers de la suite tournent en parallèle) : ce qui compte est qu'aucune
    // tranche ne tienne la boucle le temps de toute la construction.
    expect(max).toBeLessThan(Math.max(250, total * 0.6));
    // Les genres : synonymes regroupés, étiquettes écartées.
    expect(index.facets.genres).toEqual(expect.arrayContaining(["Science-fiction", "Policier", "Fantasy", "Fantastique"]));
    expect(index.facets.genres.some((g) => /lang/i.test(g) || g === "SF")).toBe(false);
    // L'accueil est déjà calculé, et borné.
    expect(index.home.rows.length).toBeLessThanOrEqual(10);
    // Une page, une recherche : bornées, rapides.
    const t1 = performance.now();
    const page = pageOf(index, { tri: "title", offset: 240, limit: 120 });
    const found = searchIndex(index, "livre 123");
    const lookups = performance.now() - t1;
    console.log(`[livres] une page triée + une recherche sur 6 400 : ${lookups.toFixed(1)} ms`);
    expect(page.books).toHaveLength(120);
    expect(page.total).toBe(6400);
    expect(found.length).toBeLessThanOrEqual(12);
    expect(found[0].name).toBe("Livre 123");
  });

  it("la file des OPF : 5 000 livres lus sans tenir la boucle, écrits par lots", async () => {
    const q = metaTesting.queue();
    const realReader = q.reader;
    q.waiting.clear();
    q.playing = () => false;
    q.pausedUntil = 0;
    // Une lecture factice qui rend la main comme un vrai aller-retour réseau.
    q.reader = async () => {
      await new Promise((r) => setImmediate(r));
      return { series: "Série", seriesIndex: 1, subjects: ["Policier"], creators: ["Quelqu'un"], coverPath: "c.jpg" };
    };
    const version = q.version;
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    const t0 = performance.now();
    try {
      const { scheduleMetaReads, knownMeta } = await import("@/lib/books/epubMeta");
      const items = Array.from({ length: 5000 }, (_, i) => ({ id: hex(100_000 + i), etag: "e" }));
      scheduleMetaReads(items);
      await vi.waitFor(() => expect(q.waiting.size + q.running).toBe(0), { timeout: 30_000, interval: 20 });
      await vi.waitFor(() => expect(knownMeta().get(items[4999].id)).toBeDefined(), { timeout: 5000 });
    } finally {
      q.reader = realReader;
    }
    h.disable();
    const total = performance.now() - t0;
    const p99 = h.percentile(99) / 1e6;
    const max = h.max / 1e6;
    console.log(`[livres] file des OPF, 5 000 livres : ${total.toFixed(0)} ms, ${q.version - version} lots écrits, boucle p99 ${p99.toFixed(1)} ms, max ${max.toFixed(1)} ms`);
    // Cinq mille lectures, deux cents lots environ (25 par transaction) — jamais une écriture par livre.
    expect(q.version - version).toBeLessThanOrEqual(5000 / 20);
    expect(max).toBeLessThan(250);
  });
});

describe("l'accueil d'une grande bibliothèque", () => {
  it("reste borné : au plus dix rangées de séries, d'auteurs et de genres, vingt livres chacune", () => {
    const books = library();
    const { rows, recent, hidden, resume } = homeRows(books);
    expect(rows.length).toBeLessThanOrEqual(10);
    for (const row of rows) expect(row.books.length).toBeLessThanOrEqual(20);
    // Des trois sortes, dans l'ordre : séries, auteurs, genres.
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual([...kinds].sort((a, b) => ["series", "author", "genre"].indexOf(a) - ["series", "author", "genre"].indexOf(b)));
    expect(new Set(kinds)).toEqual(new Set(["series", "author", "genre"]));
    // Les livres sans série ne forment jamais une rangée de mille.
    expect(rows.every((r) => r.title !== "books.others")).toBe(true);
    expect(hidden).toBeGreaterThan(400);
    expect(recent).toHaveLength(20);
    expect(recent[0].addedAt).toBe(Math.max(...books.map((b) => b.addedAt ?? 0)));
    expect(resume.map((b) => b.id)).toEqual([hex(3322)]);
    // Chaque rangée sait où mène son « Tout voir ».
    for (const r of rows) expect(["serie", "auteur", "genre"]).toContain(r.filter.param);
  });
});

describe("la grille complète", () => {
  it("dessine les pages reçues et demande la suivante à l'approche du bas", () => {
    let trigger: (() => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
          trigger = () => cb([{ isIntersecting: true }]);
        }
        observe() {}
        disconnect() {}
      }
    );
    const page = library().slice(0, 120);
    const onMore = vi.fn();
    const { container, rerender } = render(<BooksGrid books={page} onOpen={() => {}} more onMore={onMore} seriesCounts={{ "Série 000": 10 }} />);
    expect(container.querySelectorAll("[data-book-id]")).toHaveLength(120);
    expect(container.querySelector("[data-grid-more]")).not.toBeNull();
    act(() => trigger?.());
    expect(onMore).toHaveBeenCalledTimes(1);
    // Plus rien à demander : plus de repère.
    rerender(<BooksGrid books={page} onOpen={() => {}} more={false} onMore={onMore} />);
    expect(container.querySelector("[data-grid-more]")).toBeNull();
  });

  it("la recherche trouve par titre, série ou auteur, sans accents ni casse", () => {
    const books = library();
    expect(filterBooks(books, "elodie").length).toBe(books.filter((b) => b.authors[0] === "Élodie Durand").length);
    expect(filterBooks(books, "série 007").every((b) => b.seriesName === "Série 007")).toBe(true);
    expect(filterBooks(books, "roman 4999")).toHaveLength(1);
    expect(filterBooks(books, "", "Série 010")).toHaveLength(10);
    expect(filterBooks(books, "", NO_SERIES)).toHaveLength(1000);
  });
});
