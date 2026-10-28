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

import { __testing, acceptable, bestCandidate, enrichOf, googleGenres, recordOf, redact, signature, startGoogleEnrich, titleVariants, titlesMatch, type EnrichTarget, type GoogleVolume } from "@/lib/books/googleBooks";
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

  it("texte libre, 20 réponses ; l'ISBN du livre reconnaît son édition ; la clé dans l'en-tête, jamais dans l'adresse ; le livre noté une fois", async () => {
    const edition = vol("Dans les bois", ["Harlan Coben"], { industryIdentifiers: [{ type: "ISBN_13", identifier: "9782266154956" }], description: "court mais suffisant pour être retenu, une phrase." }, "edition");
    const other = vol("Dans les bois", ["Harlan Coben"], { description: "Un résumé beaucoup plus long que celui de l'édition attendue, mais ce n'est pas la nôtre : elle n'a pas notre ISBN." }, "autre");
    google(() => new Response(JSON.stringify({ items: [other, edition] })));
    __testing.state().targets = async () => [target({ isbn: "978-2-266-15495-6" })];
    await __testing.run("essai");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).not.toContain(KEY);
    expect(new URL(calls[0].url).searchParams.get("q")).toBe("Dans les bois Harlan Coben");
    expect(new URL(calls[0].url).searchParams.get("maxResults")).toBe("20");
    expect(enrichOf("a".repeat(32))?.overview).toContain("court mais suffisant");
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
    expect(new URL(calls[0].url).searchParams.get("q")).toBe("Dans les bois Harlan Coben");
    expect(new URL(calls[0].url).searchParams.get("langRestrict")).toBe("fr");
    expect(new URL(calls[1].url).searchParams.has("langRestrict")).toBe(false);
    expect(enrichOf("a".repeat(32))).toMatchObject({ status: "nomatch", overview: null });
  });

  it("429 : arrêt jusqu'au lendemain ; 503 : pas compté comme essayé, réessayé plus tard", async () => {
    __testing.state().targets = async () => [target(), target({ id: "b".repeat(32), name: "Autre" })];
    google(() => new Response("", { status: 503 }));
    await __testing.run("essai");
    expect(enrichOf("a".repeat(32))).toBeNull();
    // Trois tentatives de la même requête, puis la file s'arrête (reprise plus tard).
    expect(calls).toHaveLength(3);
    expect(__testing.quota().requests).toBe(3);
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

describe("règles v2 : les cas réels de la première passe en production", () => {
  const pullman = target({
    name: "La Tour des anges",
    authors: ["Philip Pullman"],
    series: "À la croisée des mondes",
    index: 2,
    siblings: ["Les Royaumes du Nord", "Le Miroir d'ambre"],
  });
  it("« La Tour des anges » ne prend ni l'intégrale, ni le tome 1, ni un résumé du tome 1", () => {
    const lyra = "Pourquoi la jeune Lyra, élevée dans l'atmosphère confinée du prestigieux Jordan College, est-elle l'objet de tant d'attentions ? Les Royaumes du Nord l'attendent.";
    expect(acceptable(pullman, vol("À la croisée des mondes", ["Philip Pullman"], { subtitle: "Les Royaumes du Nord ; La Tour des anges ; Le Miroir d'ambre" }))).toBe(false);
    expect(acceptable(pullman, vol("À la croisée des mondes - L'intégrale", ["Philip Pullman"]))).toBe(false);
    expect(acceptable(pullman, vol("La Tour des anges", ["Philip Pullman"], { subtitle: "À la croisée des mondes, tome 1" }))).toBe(false);
    expect(acceptable(pullman, vol("La Tour des anges", ["Philip Pullman"], { description: lyra }))).toBe(false);
    expect(acceptable(pullman, vol("La Tour des anges : la croisée des mondes 1-3", ["Philip Pullman"]))).toBe(false);
    // Le bon volume passe.
    expect(acceptable(pullman, vol("La Tour des anges", ["Philip Pullman"], { subtitle: "À la croisée des mondes, tome 2", description: "Will, douze ans, fuit son monde et découvre une ville étrange." }))).toBe(true);
  });
  it("plus de « l'un contient l'autre » : un sous-titre après « : » seulement, et jamais un autre titre de l'auteur", () => {
    expect(titlesMatch("La Tour des anges", "La Tour des anges : roman")).toBe(true);
    expect(titlesMatch("La Tour des anges", "La Tour des anges et autres récits")).toBe(false);
    expect(titlesMatch("Les Royaumes du Nord", "Les Royaumes du Nord - La Tour des anges", ["La Tour des anges"])).toBe(false);
  });
  it("les titres préfixés par un code ou un numéro de série sont nettoyés", () => {
    expect(titleVariants("APE18 5 L'or maudit du pharaon")[0]).toBe("L'or maudit du pharaon");
    expect(titleVariants("Alex Cross 03 Jack et Jill")).toEqual(expect.arrayContaining(["Jack et Jill"]));
    expect(titleVariants("L'accro du shopping 3 dit oui")[0]).toBe("L'accro du shopping dit oui");
    expect(titleVariants("Accro du shopping 5 a un bébé")[0]).toBe("Accro du shopping a un bébé");
    expect(titleVariants("Dans les bois")).toEqual(["Dans les bois"]);
    // Une variante nettoyée trouve « L'accro du shopping a un bébé » (article de tête ignoré).
    const t = target({ name: "Accro du shopping 5 a un bébé", authors: ["Sophie Kinsella"] });
    expect(acceptable(t, vol("L'accro du shopping a un bébé", ["Sophie Kinsella"]), false, titleVariants(t.name))).toBe(true);
  });
  it("les catégories anglaises sont ramenées au vocabulaire, le reste laissé", () => {
    expect(googleGenres(["Arctic regions"])).toEqual([]);
    expect(googleGenres(["Fiction / General"])).toEqual([]);
    expect(googleGenres(["Fiction / Mystery & Detective / General"])).toEqual(["Policier"]);
    expect(googleGenres(["Juvenile Fiction / Fantasy & Magic"])).toEqual(["Fantasy", "Jeunesse"]);
    expect(googleGenres(["Fiction / Science Fiction / Space Opera", "Fiction / Thrillers / Suspense"])).toEqual(["Science-fiction", "Thriller"]);
    expect(recordOf(vol("X", ["Y"], { categories: ["Arctic regions"] })).genres).toEqual([]);
  });
  it("les lignes faites par les règles v1 sont réévaluées, les remplies d'abord", async () => {
    const insert = getDb().prepare("INSERT INTO book_enrich (item_id, sig, rules, status, overview, genres, checked_at) VALUES (?, ?, 1, ?, ?, '[\"Arctic regions\"]', 1)");
    insert.run("c".repeat(32), signature({ ...pullman, name: "Autre" }), "nomatch", null);
    insert.run("a".repeat(32), signature(pullman), "filled", "Pourquoi la jeune Lyra…");
    // Une ligne v1 ne montre plus un genre hors du vocabulaire.
    expect(enrichOf("a".repeat(32))?.genres).toEqual([]);
    const order: string[] = [];
    google((u) => {
      order.push(u.searchParams.get("q") ?? "");
      return new Response(JSON.stringify({ items: [] }));
    });
    __testing.state().targets = async () => [{ ...pullman, id: "c".repeat(32), name: "Autre" }, pullman];
    await __testing.run("essai");
    expect(order[0]).toContain("La Tour des anges");
    // Sans correspondance avec les nouvelles règles : le mauvais résumé est effacé.
    expect(enrichOf("a".repeat(32))).toMatchObject({ status: "nomatch", overview: null });
  });
});

describe("règles v3 : les réponses réelles de Google en texte libre", () => {
  const desc = (n: number) => "Lorem ipsum dolor sit amet, ".repeat(Math.ceil(n / 28)).slice(0, n);
  it("« Charlotte » : la bonne édition au milieu des études, des autres langues et des magazines", () => {
    const t = target({ name: "Charlotte", authors: ["David Foenkinos"] });
    const items = [
      vol("Charlotte", ["David Foenkinos"], { subtitle: "by David Foenkinos", language: "en", description: desc(200) }, "en"),
      vol("Charlotte by David Foenkinos", ["Laurence Lissoir"], { subtitle: "Analysis", description: desc(300) }, "analyse"),
      vol("Paris Match", ["Collectif"], { description: desc(500) }, "magazine"),
      vol("Charlotte", ["David Foenkinos"], { subtitle: "roman", language: "fr", description: desc(260) }, "roman"),
      vol("Charlotte", ["David Foenkinos"], { language: "de", description: desc(900) }, "de"),
      vol("Charlotte", ["David Foenkinos"], { language: "fr", description: desc(812) }, "fr-long"),
    ];
    expect(bestCandidate(t, items)?.id).toBe("fr-long");
  });
  it("« La tour des anges » : le roman, ni la BD (tome 1, trois auteurs) ni « Lyra et les oiseaux »", () => {
    const t = target({ name: "La Tour des anges", authors: ["Philip Pullman"], series: "À la croisée des mondes", index: 2, siblings: ["Les Royaumes du Nord", "Lyra et les oiseaux"] });
    const items = [
      vol("La Tour des Anges (Tome 1)", ["Philip Pullman", "Stéphane Melchior", "Thomas Gilbert"], { description: desc(400) }, "bd"),
      vol("Lyra et les oiseaux", ["Philip Pullman"], { description: desc(700) }, "lyra"),
      vol("À la croisée des mondes (Tome 2) - La Tour des Anges", ["Philip Pullman"], { description: desc(600) }, "serie"),
      vol("La tour des anges", ["Philip Pullman"], { description: desc(329) }, "court"),
      vol("La tour des anges", ["Philip Pullman"], { description: desc(1986) }, "long"),
      vol("La tour des anges", ["Philip Pullman"], { description: desc(546) }, "moyen"),
    ];
    expect(bestCandidate(t, items)?.id).toBe("long");
    expect(acceptable(t, items[0])).toBe(false);
  });
  it("« Dans les bois » : trouvé parmi les magazines", () => {
    const items = [vol("Le Point", ["Collectif"]), vol("Télérama", ["Collectif"]), vol("Dans les bois", ["Harlan Coben"], { description: desc(937) }, "bon")];
    expect(bestCandidate(target(), items)?.id).toBe("bon");
  });
  it("un 503 sur deux : la même requête est retentée, et le livre est rempli", async () => {
    let n = 0;
    google(() => (++n % 2 === 1 ? new Response("", { status: 503 }) : new Response(JSON.stringify({ items: [vol("Dans les bois", ["Harlan Coben"])] }))));
    __testing.state().targets = async () => [target()];
    await __testing.run("essai");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).search).toBe(new URL(calls[1].url).search);
    expect(enrichOf("a".repeat(32))?.status).toBe("filled");
  });
});
