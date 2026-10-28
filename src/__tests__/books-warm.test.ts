import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { NextRequest } from "next/server";

/**
 * L'index des livres (DECISIONS.md §127) : une copie par livre, et préparé d'avance.
 *
 * Les doublons viennent de la vraie bibliothèque de production — neuf groupes, la plupart dans un même
 * lot (« Les cavernes d acier » et « Les cavernes d'acier »), un entre deux racines. Les fichiers restent
 * sur le disque (le lot est partagé) : l'index n'en montre qu'un, et l'autre reste lisible.
 *
 * Le préchauffage : rien option coupée ; après les préchauffages du catalogue sinon ; et l'accueil répond
 * de l'index chaud en quelques millisecondes.
 */
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "laterna-books-warm-"));
});
const cfg = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/config", () => ({
  config: {
    jellyfin: { url: "http://jf", apiKey: "k" },
    books: {
      get enabled() {
        return cfg.on;
      },
    },
  },
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
const upstream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: (...a: unknown[]) => upstream(...a), passJellyfinFetch: (...a: unknown[]) => upstream(...a) }));
vi.mock("@/lib/blockedTags", () => ({ blockedTagsOf: async () => [], carriesBlockedTag: () => false }));
vi.mock("@/lib/taskLog", () => ({ taskLog: () => {} }));

import { duplicateKey, titleKey } from "@/lib/books/metadata";
import { accountCopies, buildIndex, bookIndex, resumeFrom, withProgress, __testing as indexTesting } from "@/lib/books/bookIndex";
import { __testing as metaTesting } from "@/lib/books/epubMeta";
import { __testing as rightsTesting } from "@/lib/books/rights";
import { prewarmBooks, startBooksPrewarm, CATALOGUE_WARMED, __testing as prewarmTesting } from "@/lib/books/prewarm";
import type { LibraryItem } from "@/lib/books/library";
import type { BookProgress } from "@/lib/books/types";

const hex = (n: number) => n.toString(16).padStart(32, "0");
const item = (n: number, name: string, author: string, over: Partial<LibraryItem> = {}): LibraryItem => ({
  Id: hex(n),
  Name: name,
  Type: "Book",
  People: [{ Name: author, Type: "Author" }],
  library: "l",
  ...over,
});

/** Les paires de la bibliothèque de production. */
const PAIRS: [string, string, string][] = [
  ["Les cavernes d acier", "Les cavernes d'acier", "Isaac Asimov"],
  ["Le Roi de fer", "Roi de fer", "Maurice Druon"],
  ["La cinquième femme", "La cinquième femme", "Henning Mankell"],
  ["Prelude a Fondation", "Prélude à Fondation", "Isaac Asimov"],
  ["L'amour, vous connaissez", "L'amour vous connaissez _", "Quelqu'un"],
  ["La Pays des fourrures", "Le pays des fourrures", "Jules Verne"],
  ["Sauve-moi", "Sauve-moi", "Guillaume Musso"],
];

beforeEach(() => {
  vi.clearAllMocks();
  cfg.on = true;
  indexTesting.reset();
  rightsTesting.reset();
  prewarmTesting.reset();
  metaTesting.queue().waiting.clear();
  metaTesting.queue().playing = () => true;
  verify.mockResolvedValue({ u: "lecteur", role: "user", jfId: "c".repeat(32), jti: "t" });
});
afterEach(() => vi.useRealTimers());

describe("une copie par livre", () => {
  it("les paires réelles ont la même clé ; « Asimov,Isaac » et « Isaac Asimov » sont un auteur", () => {
    for (const [a, b, author] of PAIRS) expect(duplicateKey({ name: a, authors: [author] }), `${a} / ${b}`).toBe(duplicateKey({ name: b, authors: [author] }));
    expect(duplicateKey({ name: "Les cavernes d'acier", authors: ["Asimov,Isaac"] })).toBe(duplicateKey({ name: "Les cavernes d acier", authors: ["Isaac Asimov"] }));
    // Deux livres différents du même auteur ne se confondent pas, ni un même titre de deux auteurs.
    expect(duplicateKey({ name: "Fondation", authors: ["Isaac Asimov"] })).not.toBe(duplicateKey({ name: "Prélude à Fondation", authors: ["Isaac Asimov"] }));
    expect(duplicateKey({ name: "Sauve-moi", authors: ["Guillaume Musso"] })).not.toBe(duplicateKey({ name: "Sauve-moi", authors: ["Autre"] }));
    expect(titleKey("Le Roi de fer")).toBe("roi de fer");
  });

  it("une seule visible partout (pages, nombres, menus, recherche) ; la mieux tenue ; l'autre reste lisible", async () => {
    const items = PAIRS.flatMap(([a, b, author], i) => [item(i * 2 + 1, a, author), item(i * 2 + 2, b, author, i === 6 ? { library: "packs" } : {})]);
    // Une couverture l'emporte sur un titre mieux écrit.
    items[0].ImageTags = { Primary: "p" };
    const index = await buildIndex(items);
    expect(index.books).toHaveLength(PAIRS.length);
    const names = index.books.map((b) => b.name);
    expect(names).toContain("Les cavernes d acier");
    expect(names).toContain("Prélude à Fondation");
    expect(names).toContain("Le Roi de fer");
    expect(names).toContain("L'amour, vous connaissez");
    expect(index.facets.authors.filter((a) => /asimov/i.test(a))).toHaveLength(1);
    // Les copies cachées : lisibles d'un lien direct, et chacune renvoie à celle montrée.
    expect(index.all.size).toBe(PAIRS.length * 2);
    expect(index.hiddenTo.get(hex(2))).toBe(hex(1));
  });

  it("chez un compte qui a commencé la copie cachée, c'est elle qui est montrée — et reprise", async () => {
    const index = await buildIndex([item(1, "Prelude a Fondation", "Isaac Asimov"), item(2, "Prélude à Fondation", "Isaac Asimov")]);
    expect(index.books.map((b) => b.id)).toEqual([hex(2)]);
    const progress = new Map<string, BookProgress>([[hex(1), { cfi: "epubcfi(/6/2)", fraction: 0.4, updatedAt: 1, finished: false }]]);
    const copies = accountCopies(index, progress.keys());
    expect(withProgress(index.books, progress, new Set(), copies).map((b) => [b.id, b.progress?.fraction])).toEqual([[hex(1), 0.4]]);
    expect(resumeFrom(index, progress).map((b) => b.id)).toEqual([hex(1)]);
  });
});

describe("le préchauffage", () => {
  const library = (n: number) => Array.from({ length: n }, (_, i) => item(i + 1, `Livre ${i}`, `Auteur ${i % 1464}`, { DateCreated: new Date(1_700_000_000_000 + i * 60_000).toISOString() }));
  function serve(items: LibraryItem[]) {
    upstream.mockImplementation(async (url: string) => {
      if (url.endsWith("/Library/VirtualFolders")) return new Response(JSON.stringify([{ ItemId: "l", CollectionType: "books" }]));
      if (/\/Users\/c{32}$/.test(url)) return new Response(JSON.stringify({ Policy: { EnableAllFolders: true } }));
      const u = new URL(url);
      if (u.searchParams.get("IsPlayed") === "true") return new Response(JSON.stringify({ Items: [] }));
      const start = Number(u.searchParams.get("StartIndex") ?? 0);
      const limit = Number(u.searchParams.get("Limit") ?? 1000);
      return new Response(JSON.stringify({ Items: items.slice(start, start + limit), TotalRecordCount: items.length }));
    });
  }

  it("option coupée : rien ne part, ni au démarrage ni plus tard", async () => {
    vi.useFakeTimers();
    cfg.on = false;
    serve(library(10));
    startBooksPrewarm();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await prewarmBooks("essai");
    expect(upstream).not.toHaveBeenCalled();
    expect(prewarmTesting.state().keepWarm).toBeNull();
  });

  it("au démarrage : après les préchauffages du catalogue, jamais avant", async () => {
    vi.useFakeTimers();
    serve(library(50));
    startBooksPrewarm();
    await vi.advanceTimersByTimeAsync(45_000);
    // Le catalogue n'a pas fini : l'index attend son tour.
    expect(upstream).not.toHaveBeenCalled();
    (globalThis as unknown as Record<symbol, unknown>)[CATALOGUE_WARMED] = Date.now();
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(indexTesting.shared().base?.entries.length).toBe(50));
    prewarmTesting.reset();
  });

  it("6 400 livres : construits derrière la boucle, puis l'accueil répond de l'index chaud en quelques millisecondes", async () => {
    serve(library(6400));
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    const t0 = performance.now();
    await prewarmBooks("essai");
    const built = performance.now() - t0;
    h.disable();
    const { GET } = await import("@/app/api/books/home/route");
    const req = { cookies: { get: () => ({ value: "t" }) }, headers: new Headers(), nextUrl: new URL("http://l/api/books/home") } as unknown as NextRequest;
    await GET(req); // la vue de ce compte (ses droits), une fois
    const t1 = performance.now();
    const res = await GET(req);
    const answered = performance.now() - t1;
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(6400);
    console.log(
      `[livres] préchauffage de 6 400 livres : ${built.toFixed(0)} ms, boucle p99 ${(h.percentile(99) / 1e6).toFixed(1)} ms, max ${(h.max / 1e6).toFixed(1)} ms ; accueil depuis l'index chaud : ${answered.toFixed(1)} ms`
    );
    expect(h.max / 1e6).toBeLessThan(250);
    expect(answered).toBeLessThan(100);
    prewarmTesting.reset();
  });
});
