import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Google Books (option, DECISIONS.md §127) : seulement ce qui manque, seulement quand on est sûr, sans
 * jamais montrer la clé, sans dépasser le quota. Toutes les réponses de Google sont simulées.
 */
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "laterna-books-google-"));
});
const KEY = "AIzaSy-secret-cle-de-test-0123456789";
const cfg = vi.hoisted(() => ({ books: true, enrich: true, key: "AIzaSy-secret-cle-de-test-0123456789" }));
vi.mock("@/lib/config", () => ({
  config: {
    jellyfin: { url: "http://jf", apiKey: "k" },
    books: {
      get enabled() {
        return cfg.books;
      },
      get googleEnrich() {
        return cfg.books && cfg.enrich && cfg.key !== "";
      },
      get googleKey() {
        return cfg.key;
      },
    },
  },
}));
const logged = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/logger", () => ({ logError: (_s: string, e: unknown) => logged.push(String((e as Error)?.message ?? e)) }));
vi.mock("@/lib/taskLog", () => ({ taskLog: (...a: unknown[]) => logged.push(JSON.stringify(a)) }));

import { __testing, acceptable, bestCandidate, enrichOf, recordOf, redact, startGoogleEnrich, titlesMatch, type EnrichTarget, type GoogleVolume } from "@/lib/books/googleBooks";
import { summaryOf } from "@/lib/books/library";
import { getDb } from "@/lib/db";

const vol = (title: string, authors: string[], extra: Partial<NonNullable<GoogleVolume["volumeInfo"]>> = {}, id = "g1"): GoogleVolume => ({
  id,
  volumeInfo: { title, authors, language: "fr", description: "<p>Un <b>résumé</b> assez long pour être retenu, avec plusieurs phrases.</p>", categories: ["Fiction / Thrillers"], publishedDate: "2007-03-01", imageLinks: { thumbnail: "http://books.google.com/books/content?id=x&printsec=frontcover&img=1&zoom=1&edge=curl" }, ...extra },
});
const target = (over: Partial<EnrichTarget> = {}): EnrichTarget => ({
  id: "a".repeat(32),
  name: "Dans les bois",
  authors: ["Harlan Coben"],
  isbn: null,
  needs: { overview: true, cover: false, genres: false, year: false },
  ...over,
});

let calls: { url: string; init: RequestInit }[] = [];
function google(answer: (url: URL) => Response) {
  const s = __testing.state();
  s.fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return answer(new URL(String(input)));
  }) as typeof fetch;
  s.sleep = async () => {};
}

beforeEach(() => {
  calls = [];
  logged.length = 0;
  Object.assign(cfg, { books: true, enrich: true, key: KEY });
  getDb().prepare("DELETE FROM book_enrich").run();
  getDb().prepare("DELETE FROM book_enrich_quota").run();
  const s = __testing.state();
  if (s.wake) clearTimeout(s.wake);
  s.wake = null;
  s.running = false;
});
afterEach(() => vi.useRealTimers());

describe("la correspondance", () => {
  it("retient la bonne édition, refuse l'analyse de l'œuvre et les études", () => {
    const t = target();
    const guide = vol("L'inconnu de la forêt de Harlan Coben (Analyse de l'œuvre)", ["Lucile Lhoste"], { publisher: "lePetitLitteraire.fr" }, "guide");
    const right = vol("Dans les bois", ["Harlan Coben"], {}, "bon");
    expect(acceptable(t, guide)).toBe(false);
    expect(acceptable(t, vol("Dans les bois", ["Harlan Coben"], { subtitle: "Fiche de lecture" }))).toBe(false);
    expect(acceptable(t, vol("Dans les bois", ["Quelqu'un d'autre"]))).toBe(false);
    expect(bestCandidate(t, [guide, right])?.id).toBe("bon");
    // Article et ponctuation ignorés, ordre des noms aussi.
    expect(acceptable({ name: "Le Roi de fer", authors: ["Druon, Maurice"] }, vol("Roi de fer", ["Maurice Druon"]))).toBe(true);
    expect(titlesMatch("La cinquième femme", "Cinquieme femme")).toBe(true);
    expect(titlesMatch("Dans les bois", "Dans les bois profonds et sombres de la ville")).toBe(false);
  });
  it("ce qu'un volume apporte : un résumé en texte, l'image agrandie en https, les genres regroupés, l'année", () => {
    const r = recordOf(vol("Dans les bois", ["Harlan Coben"]));
    expect(r.overview).toBe("Un résumé assez long pour être retenu, avec plusieurs phrases.");
    expect(r.coverUrl).toBe("https://books.google.com/books/content?id=x&printsec=frontcover&img=1&zoom=2");
    expect(r.genres).toEqual(["Thriller"]);
    expect(r.year).toBe(2007);
  });
});

describe("la file", () => {
  it("option coupée, livres coupés ou sans clé : aucune requête", async () => {
    google(() => new Response(JSON.stringify({ items: [] })));
    __testing.state().targets = async () => [target()];
    for (const c of [{ enrich: false }, { books: false }, { key: "" }]) {
      Object.assign(cfg, { books: true, enrich: true, key: KEY }, c);
      startGoogleEnrich("essai");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls).toHaveLength(0);
  });

  it("l'ISBN d'abord ; la clé dans l'en-tête, jamais dans l'adresse ; le livre noté une fois", async () => {
    google((u) => new Response(JSON.stringify({ items: u.searchParams.get("q") === "isbn:9782266154956" ? [vol("Dans les bois", ["Harlan Coben"])] : [] })));
    __testing.state().targets = async () => [target({ isbn: "978-2-266-15495-6" })];
    await __testing.run("essai");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain(KEY);
    expect(new URL(calls[0].url).searchParams.get("q")).toBe("isbn:9782266154956");
    expect(new Headers(calls[0].init.headers).get("x-goog-api-key")).toBe(KEY);
    expect(enrichOf("a".repeat(32))).toMatchObject({ status: "filled", year: 2007 });
    // Une seconde passe : rien de redemandé.
    await __testing.run("essai");
    expect(calls).toHaveLength(1);
  });

  it("titre et auteur, encodés une seule fois ; deux requêtes au plus ; sans correspondance, rien n'est rempli", async () => {
    google(() => new Response(JSON.stringify({ items: [vol("L'inconnu de la forêt de Harlan Coben (Analyse de l'œuvre)", ["X"])] })));
    __testing.state().targets = async () => [target()];
    await __testing.run("essai");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).searchParams.get("q")).toBe("intitle:Dans les bois inauthor:coben");
    expect(new URL(calls[0].url).searchParams.get("langRestrict")).toBe("fr");
    expect(new URL(calls[1].url).searchParams.has("langRestrict")).toBe(false);
    expect(enrichOf("a".repeat(32))).toMatchObject({ status: "nomatch", overview: null });
  });

  it("429 : arrêt jusqu'au lendemain ; 503 : pas compté comme essayé, réessayé plus tard", async () => {
    __testing.state().targets = async () => [target(), target({ id: "b".repeat(32), name: "Autre" })];
    google(() => new Response("", { status: 503 }));
    await __testing.run("essai");
    expect(enrichOf("a".repeat(32))).toBeNull();
    expect(calls).toHaveLength(1);
    calls = [];
    google(() => new Response("", { status: 429 }));
    await __testing.run("essai");
    expect(calls).toHaveLength(1);
    expect(__testing.quota().blocked).toBe(true);
    calls = [];
    await __testing.run("essai");
    expect(calls).toHaveLength(0);
  });

  it("le plafond du jour", async () => {
    getDb().prepare("INSERT INTO book_enrich_quota (day, requests) VALUES (?, ?)").run((await import("@/lib/books/googleBooks")).quotaDay(), __testing.DAILY_CAP - 1);
    google(() => new Response(JSON.stringify({ items: [] })));
    __testing.state().targets = async () => [target()];
    await __testing.run("essai");
    expect(calls).toHaveLength(0);
  });

  it("une erreur qui contient la clé n'arrive jamais dans un journal", async () => {
    expect(redact(`fetch failed for https://x/?key=${KEY}&q=a`, KEY)).not.toContain(KEY);
    google(() => {
      throw new Error(`connect ECONNREFUSED https://www.googleapis.com/books/v1/volumes?key=${KEY}`);
    });
    __testing.state().targets = async () => [target()];
    await __testing.run("essai");
    expect(logged.join("\n")).not.toContain(KEY);
  });
});

describe("seulement ce qui manque", () => {
  it("l'année et les genres de Jellyfin l'emportent ; ceux de Google comblent les vides", () => {
    const rec = { status: "filled" as const, overview: "Résumé", genres: ["Thriller"], year: 2007, coverUrl: null };
    const own = summaryOf({ Id: "a".repeat(32), Name: "X", Type: "Book", ProductionYear: 1999, Genres: ["Policier"] }, null, rec);
    expect([own.year, own.genres]).toEqual([1999, ["Policier"]]);
    const empty = summaryOf({ Id: "a".repeat(32), Name: "X", Type: "Book" }, null, rec);
    expect([empty.year, empty.genres]).toEqual([2007, ["Thriller"]]);
    const nomatch = summaryOf({ Id: "a".repeat(32), Name: "X", Type: "Book" }, null, { ...rec, status: "nomatch" });
    expect([nomatch.year, nomatch.genres]).toEqual([null, []]);
  });
});

describe("l'administration", () => {
  it("allumer l'option depuis les réglages lance la file", async () => {
    const route = (await import("node:fs")).readFileSync((await import("node:path")).join(process.cwd(), "src/app/api/settings/route.ts"), "utf8");
    expect(route).toMatch(/BOOKS_GOOGLE_ENRICH[\s\S]{0,200}config\.books\.googleEnrich[\s\S]{0,200}startGoogleEnrich\("option allumée"\)/);
    const { SETTINGS_BY_KEY } = await import("@/lib/settings/schema");
    // Réglables dans l'application, coupée par défaut ; la clé est un secret (jamais renvoyée au navigateur).
    expect(SETTINGS_BY_KEY.get("BOOKS_GOOGLE_ENRICH")).toMatchObject({ kind: "boolean", fallback: "false", inApp: true });
    expect(SETTINGS_BY_KEY.get("GOOGLE_BOOKS_API_KEY")).toMatchObject({ kind: "secret", need: "optional", inApp: true });
  });
});
