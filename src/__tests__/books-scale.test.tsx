// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

/**
 * Les livres à l'échelle d'une grande bibliothèque (DECISIONS.md §127) : plusieurs milliers d'EPUB.
 * La liste est demandée à Jellyfin par pages et sans résumés, l'accueil reste borné, la grille ne
 * dessine qu'un morceau à la fois et la recherche trouve par titre, série ou auteur.
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

import { LIST_PAGE, listBooks } from "@/lib/books/library";
import { NO_SERIES, filterBooks, homeRows } from "@/lib/books/grouping";
import { BooksGrid, GRID_CHUNK } from "@/components/books/BooksGrid";
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
    const books = await listBooks({ role: "user", jfId: "a".repeat(32) });
    expect(books).toHaveLength(total);
    const urls = upstream.mock.calls.map(([u]) => new URL(u as string)).filter((u) => u.searchParams.has("StartIndex"));
    expect(urls).toHaveLength(Math.ceil(total / LIST_PAGE));
    expect(urls.map((u) => u.searchParams.get("StartIndex"))).toEqual(["0", "1000", "2000"]);
    for (const u of urls) {
      expect(u.searchParams.get("Fields")).not.toMatch(/Overview/);
      expect(u.searchParams.get("Limit")).toBe(String(LIST_PAGE));
    }
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
  it("ne dessine qu'un morceau de 5 000 livres, puis le suivant à l'approche du bas", () => {
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
    const books = library();
    const t0 = performance.now();
    const { container } = render(<BooksGrid books={books} onOpen={() => {}} />);
    const firstRender = performance.now() - t0;
    expect(container.querySelectorAll("[data-book-id]")).toHaveLength(GRID_CHUNK);
    expect(container.querySelectorAll("img").length).toBeLessThanOrEqual(GRID_CHUNK);
    expect(container.querySelector("[data-grid-more]")).not.toBeNull();
    act(() => trigger?.());
    expect(container.querySelectorAll("[data-book-id]")).toHaveLength(GRID_CHUNK * 2);
    // Une borne large (jsdom est lent) : ce qui compte est qu'elle ne dépende pas de la bibliothèque.
    expect(firstRender).toBeLessThan(3000);
  });

  it("la recherche trouve par titre, série ou auteur, sans accents ni casse", () => {
    const books = library();
    expect(filterBooks(books, "elodie").length).toBe(books.filter((b) => b.authors[0] === "Élodie Durand").length);
    expect(filterBooks(books, "série 007").every((b) => b.seriesName === "Série 007")).toBe(true);
    expect(filterBooks(books, "roman 4999")).toHaveLength(1);
    expect(filterBooks(books, "", "Série 010")).toHaveLength(10);
    expect(filterBooks(books, "", NO_SERIES)).toHaveLength(1000);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) filterBooks(books, "tome 3 série");
    expect((performance.now() - t0) / 20).toBeLessThan(200);
  });
});
