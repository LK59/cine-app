import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Les routes des livres (option, DECISIONS.md §127) : coupée, elles n'existent pas ; allumée, elles ne
 * servent que des livres que le compte voit chez Jellyfin, moins ses tags bloqués (§54), relaient le
 * fichier avec la clé du serveur sans jamais la laisser paraître, et gardent la position de chacun.
 */
// Une base à soi : celle du dossier commun de la suite est ouverte par d'autres fichiers en même
// temps, et deux écrivains s'y bloquaient (« database is locked » dans un autre test).
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "laterna-books-routes-"));
});
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
const cfg = vi.hoisted(() => ({ on: true }));
const KEY = "server-key-0123456789";
vi.mock("@/lib/config", () => ({
  config: {
    jellyfin: { url: "http://jf", apiKey: "server-key-0123456789" },
    books: {
      get enabled() {
        return cfg.on;
      },
    },
  },
}));
const upstream = vi.fn();
vi.mock("@/lib/jellyfinBreaker", () => ({
  jellyfinFetch: (...a: unknown[]) => upstream(...a),
  passJellyfinFetch: (...a: unknown[]) => upstream(...a),
}));
const blocked = vi.hoisted(() => ({ tags: [] as string[] }));
vi.mock("@/lib/blockedTags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blockedTags")>();
  return { ...actual, blockedTagsOf: async () => blocked.tags };
});
const markPlayed = vi.fn();
const markUnplayed = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { markPlayed: (...a: unknown[]) => markPlayed(...a), markUnplayed: (...a: unknown[]) => markUnplayed(...a) } }));

import { GET as listGET } from "@/app/api/books/route";
import { GET as detailGET } from "@/app/api/books/[id]/route";
import { GET as fileGET } from "@/app/api/books/[id]/file/route";
import { GET as progressGET, POST as progressPOST } from "@/app/api/books/[id]/progress/route";
import { POST as readPOST, DELETE as readDELETE } from "@/app/api/books/[id]/read/route";
import { addBookmark, listBookmarks } from "@/lib/books/bookmarks";
import { GET as homeGET } from "@/app/api/books/home/route";
import { GET as facetsGET } from "@/app/api/books/facets/route";
import { GET as searchGET } from "@/app/api/books/search/route";
import { GET as coverGET } from "@/app/api/books/[id]/cover/route";
import { __testing as indexTesting } from "@/lib/books/bookIndex";
import { __testing as rightsTesting } from "@/lib/books/rights";
import { __testing as metaTesting } from "@/lib/books/epubMeta";
import { getDb } from "@/lib/db";

const BOOK = "a".repeat(32);
const MOVIE = "b".repeat(32);
const JF = "c".repeat(32);
const req = (body?: string, url = "http://l/api/books") =>
  ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers(), nextUrl: new URL(url), signal: new AbortController().signal, text: async () => body ?? "" }) as unknown as NextRequest;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const bookItem = (over: Record<string, unknown> = {}) => ({
  Id: BOOK,
  Name: "Le grand jeu",
  Type: "Book",
  SeriesName: "Cherub",
  IndexNumber: 10,
  ProductionYear: 2012,
  ImageTags: { Primary: "tag1" },
  Tags: [],
  Genres: ["Aventure"],
  People: [{ Name: "Robert Muchamore", Type: "Author" }, { Name: "Quelqu'un", Type: "Translator" }],
  Overview: "<p>Un <b>résumé</b> &amp; plus</p>",
  UserData: { Played: false },
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Deux bibliothèques de livres : la permise et une autre (`library: LIB2` sur un élément). */
const LIB1 = "1".repeat(8) + "-" + "1".repeat(4) + "-" + "1".repeat(4) + "-" + "1".repeat(4) + "-" + "1".repeat(12);
const LIB2 = "2".repeat(32);
const policy = vi.hoisted(() => ({ current: { EnableAllFolders: true, EnabledFolders: [] as string[] } as Record<string, unknown> }));

/** Ce que Jellyfin répond, selon l'adresse demandée. */
function jellyfinAnswers(items: Record<string, unknown>[], file = "PK\u0003\u0004epub") {
  const libOf = (i: Record<string, unknown>) => (i.library as string | undefined) ?? LIB1;
  // Ce que Jellyfin laisse voir à ce compte par sa propre adresse (`/Users/<id>/Items/<id>`) : les bibliothèques permises.
  const userSees = (i: Record<string, unknown>) => {
    const p = policy.current;
    if (p.EnableAllFolders !== false) return true;
    return ((p.EnabledFolders as string[]) ?? []).map((f) => f.replace(/-/g, "")).includes(libOf(i).replace(/-/g, ""));
  };
  upstream.mockImplementation(async (url: string) => {
    if (url.endsWith("/Download")) return new Response(file, { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(file.length), "X-Emby-Authorization": "leak" } });
    if (url.endsWith("/Library/VirtualFolders")) return json([{ ItemId: LIB1, CollectionType: "books" }, { ItemId: LIB2, CollectionType: "books" }, { ItemId: "9".repeat(32), CollectionType: "movies" }]);
    if (url.endsWith(`/Users/${JF}`)) return json({ Policy: policy.current });
    const one = /\/Items\/([0-9a-f]{32})\?/.exec(url)?.[1];
    if (one) {
      const item = items.find((i) => i.Id === one);
      if (url.includes("/Users/") && item && !userSees(item)) return json({}, 404);
      return item ? json(item) : json({}, 404);
    }
    const u = new URL(url);
    if (u.searchParams.get("IsPlayed") === "true") return json({ Items: items.filter((i) => (i.UserData as { Played?: boolean } | undefined)?.Played && userSees(i)) });
    const parent = u.searchParams.get("ParentId");
    const list = parent ? items.filter((i) => libOf(i) === parent) : items;
    return json({ Items: list, TotalRecordCount: list.length });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cfg.on = true;
  blocked.tags = [];
  verify.mockResolvedValue({ u: "lecteur", role: "user", jfId: JF, jti: "j" });
  policy.current = { EnableAllFolders: true, EnabledFolders: [] };
  rightsTesting.reset();
  markPlayed.mockResolvedValue(undefined);
  markUnplayed.mockResolvedValue(undefined);
  getDb().prepare("DELETE FROM book_progress").run();
  getDb().prepare("DELETE FROM book_meta").run();
  // L'index est gardé par compte, en mémoire : chaque essai repart d'une bibliothèque neuve.
  indexTesting.reset();
  metaTesting.queue().waiting.clear();
  jellyfinAnswers([bookItem()]);
});

describe("l'option coupée", () => {
  it("chaque route répond 404, sans rien demander à Jellyfin ni lire de session", async () => {
    cfg.on = false;
    const valid = JSON.stringify({ cfi: "epubcfi(/6/4!/4/2)", fraction: 0.5 });
    const statuses = [
      (await listGET(req())).status,
      (await detailGET(req(), params(BOOK))).status,
      (await fileGET(req(), params(BOOK))).status,
      (await progressGET(req(), params(BOOK))).status,
      (await progressPOST(req(valid), params(BOOK))).status,
      (await homeGET(req())).status,
      (await facetsGET(req())).status,
      (await searchGET(req())).status,
      (await coverGET(req(), params(BOOK))).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404, 404, 404, 404, 404]);
    expect(upstream).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM book_progress").get()).toEqual({ n: 0 });
  });
});

describe("qui y a droit", () => {
  it("un lien de partage n'y a jamais accès, même l'option allumée", async () => {
    verify.mockResolvedValue({ u: "partage", role: "share", jfId: JF, jti: "j", sh: "s" });
    expect((await listGET(req())).status).toBe(404);
    expect((await fileGET(req(), params(BOOK))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("sans session : 401", async () => {
    verify.mockResolvedValue(null);
    expect((await listGET(req())).status).toBe(401);
  });
  it("un compte ordinaire lit la grille", async () => {
    const res = await listGET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).books).toHaveLength(1);
  });
});

describe("GET /api/books", () => {
  it("lit la bibliothèque une fois, bibliothèque par bibliothèque, signé par l'en-tête MediaBrowser seulement", async () => {
    await listGET(req());
    const lists = upstream.mock.calls.filter(([u]) => String(u).includes("IncludeItemTypes=Book") && String(u).includes("ParentId="));
    // Les deux bibliothèques de livres, jamais celle des films.
    expect(lists.map(([u]) => new URL(String(u)).searchParams.get("ParentId")).sort()).toEqual([LIB1, LIB2].sort());
    for (const [url, init] of lists as [string, RequestInit][]) {
      expect(url).toContain("http://jf/Items?");
      expect(url).toContain("Recursive=true");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toContain(`MediaBrowser Token="${KEY}"`);
      expect(headers.get("x-emby-token")).toBeNull();
    }
    // Un second compte aux mêmes droits : rien de plus n'est demandé à Jellyfin pour la liste.
    verify.mockResolvedValue({ u: "autre", role: "user", jfId: JF, jti: "k" });
    const before = upstream.mock.calls.filter(([u]) => String(u).includes("ParentId=")).length;
    await listGET(req());
    expect(upstream.mock.calls.filter(([u]) => String(u).includes("ParentId=")).length).toBe(before);
  });

  it("un livre d'une bibliothèque interdite au compte, ou portant un de ses tags bloqués, n'existe nulle part pour lui", async () => {
    const OK = "1".repeat(32);
    const TAGGED = "3".repeat(32);
    const ELSEWHERE = "4".repeat(32);
    jellyfinAnswers([
      bookItem({ Id: OK, Name: "Permis commun", Etag: "e1" }),
      bookItem({ Id: TAGGED, Name: "Caché commun", Tags: ["Prive"], Etag: "e2" }),
      bookItem({ Id: ELSEWHERE, Name: "Ailleurs commun", library: LIB2, Etag: "e3" }),
    ]);
    blocked.tags = ["prive"];
    policy.current = { EnableAllFolders: false, EnabledFolders: [LIB1] };
    const names = (books: { name: string }[]) => books.map((b) => b.name);
    expect(names((await (await listGET(req())).json()).books)).toEqual(["Permis commun"]);
    const home = await (await homeGET(req())).json();
    expect(JSON.stringify(home)).not.toMatch(/Caché|Ailleurs/);
    expect(names((await (await searchGET(req(undefined, "http://l/api/books/search?q=commun"))).json()).books)).toEqual(["Permis commun"]);
    expect(JSON.stringify(await (await facetsGET(req())).json())).not.toMatch(/Caché|Ailleurs/);
    for (const id of [TAGGED, ELSEWHERE]) {
      expect((await coverGET(req(), params(id))).status, `couverture ${id}`).toBe(404);
      expect((await fileGET(req(), params(id))).status, `fichier ${id}`).toBe(404);
      expect((await detailGET(req(), params(id))).status, `fiche ${id}`).toBe(404);
      expect((await progressPOST(req(JSON.stringify({ cfi: "epubcfi(/6/4!/4/2)", fraction: 0.5 })), params(id))).status, `position ${id}`).toBe(404);
      expect((await readPOST(req(), params(id))).status, `marqué lu ${id}`).toBe(404);
    }
    // Aucun téléchargement du livre lui-même (la lecture de l'OPF en arrière-plan, par plages, n'en est pas un).
    const whole = upstream.mock.calls.filter(([u, init]) => String(u).endsWith("/Download") && !new Headers((init as RequestInit)?.headers).has("range"));
    expect(whole).toHaveLength(0);
    // Un compte qui a toutes les bibliothèques et aucun tag bloqué voit les trois — l'index est le même.
    policy.current = { EnableAllFolders: true };
    blocked.tags = [];
    rightsTesting.reset();
    verify.mockResolvedValue({ u: "admin2", role: "user", jfId: JF, jti: "k" });
    expect(names((await (await listGET(req())).json()).books).sort()).toEqual(["Ailleurs commun", "Caché commun", "Permis commun"]);
  });

  it("droits illisibles (Jellyfin ne répond pas sur le compte) : rien n'est montré", async () => {
    jellyfinAnswers([bookItem()]);
    const base = upstream.getMockImplementation()!;
    upstream.mockImplementation(async (url: string, init: RequestInit) => (String(url).endsWith(`/Users/${JF}`) ? json({}, 500) : base(url, init)));
    expect((await listGET(req())).status).toBe(502);
  });

  it("retire ce qui n'est pas un livre et ce qui porte un tag bloqué du compte ; trie par série, tome, nom", async () => {
    blocked.tags = ["prive"];
    // La série vient de l'EPUB (déjà lu, `book_meta`), jamais du `SeriesName` de Jellyfin — « Cherub »
    // pour tous ici, le nom de leur dossier.
    const meta = getDb().prepare("INSERT INTO book_meta (item_id, etag, series, series_index, subjects, failed, checked_at) VALUES (?, 'e', ?, ?, '[]', 0, 1)");
    meta.run("2".repeat(32), "Cherub", 2);
    meta.run("6".repeat(32), "Cherub", 1);
    jellyfinAnswers([
      bookItem({ Id: "1".repeat(32), Name: "Sans tome", IndexNumber: null }),
      bookItem({ Id: "2".repeat(32), Name: "Tome 2", IndexNumber: 2 }),
      bookItem({ Id: "3".repeat(32), Name: "Caché", Tags: ["Prive"] }),
      bookItem({ Id: "4".repeat(32), Name: "Un film", Type: "Movie" }),
      bookItem({ Id: "5".repeat(32), Name: "Seul", SeriesName: null, IndexNumber: null, People: [], ImageTags: {} }),
      bookItem({ Id: "6".repeat(32), Name: "Tome 1", IndexNumber: 1 }),
    ]);
    const { books } = await (await listGET(req())).json();
    expect(books.map((b: { name: string }) => b.name)).toEqual(["Tome 1", "Tome 2", "Sans tome", "Seul"]);
    expect(books.map((b: { seriesName: string | null }) => b.seriesName)).toEqual(["Cherub", "Cherub", null, null]);
    const seul = books[3];
    expect(seul).toMatchObject({ seriesName: null, index: null, authors: [], coverTag: null });
    expect(books[0].authors).toEqual(["Robert Muchamore"]);
  });

  it("joint la position de ce compte, et de lui seul", async () => {
    getDb().prepare("INSERT INTO book_progress (account, item_id, cfi, fraction, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)").run("lecteur", BOOK, "epubcfi(/6/2)", 0.4, 1, null);
    getDb().prepare("INSERT INTO book_progress (account, item_id, cfi, fraction, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)").run("autre", BOOK, "epubcfi(/6/8)", 0.9, 1, null);
    const { books } = await (await listGET(req())).json();
    expect(books[0].progress).toMatchObject({ cfi: "epubcfi(/6/2)", fraction: 0.4, finished: false });
  });

  it("Jellyfin injoignable : 502, sans détail", async () => {
    upstream.mockResolvedValue(json({}, 500));
    const res = await listGET(req());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("jf");
  });
});

describe("l'index du compte : l'accueil, les pages, la recherche", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => bookItem({ Id: (i + 1).toString(16).padStart(32, "0"), Name: `Livre ${String(i).padStart(4, "0")}`, DateCreated: new Date(1_700_000_000_000 + i * 1000).toISOString() }));

  it("Jellyfin n'est demandé qu'une fois : l'accueil, les pages, les choix et la recherche viennent de la mémoire", async () => {
    jellyfinAnswers(many(300));
    await homeGET(req());
    const calls = upstream.mock.calls.length;
    await listGET(req(undefined, "http://l/api/books?offset=120&limit=120"));
    await facetsGET(req());
    for (const q of ["li", "liv", "livre", "livre 02"]) await searchGET(req(undefined, `http://l/api/books/search?q=${encodeURIComponent(q)}`));
    expect(upstream.mock.calls.length).toBe(calls);
  });

  it("une page bornée, avec le total ; l'accueil borné quelle que soit la bibliothèque", async () => {
    jellyfinAnswers(many(450));
    const page = await (await listGET(req(undefined, "http://l/api/books?offset=400&limit=500"))).json();
    expect(page.total).toBe(450);
    expect(page.books).toHaveLength(50);
    const capped = await (await listGET(req(undefined, "http://l/api/books?limit=5000"))).json();
    expect(capped.books).toHaveLength(200);
    const home = await (await homeGET(req())).json();
    expect(home.total).toBe(450);
    expect(home.recent.length).toBeLessThanOrEqual(20);
    expect(home.recent[0].name).toBe("Livre 0449");
    expect(JSON.stringify(home).length).toBeLessThan(200_000);
  });

  it("la recherche : douze au plus, rien sous deux lettres", async () => {
    jellyfinAnswers(many(100));
    expect((await (await searchGET(req(undefined, "http://l/api/books/search?q=l"))).json()).books).toEqual([]);
    expect((await (await searchGET(req(undefined, "http://l/api/books/search?q=livre"))).json()).books).toHaveLength(12);
    const exact = (await (await searchGET(req(undefined, "http://l/api/books/search?q=livre%200042"))).json()).books;
    expect(exact.map((b: { name: string }) => b.name)).toEqual(["Livre 0042"]);
  });

  it("une couverture n'est servie que pour un livre de l'index du compte", async () => {
    jellyfinAnswers([bookItem({ Etag: null })]);
    expect((await coverGET(req(), params("9".repeat(32)))).status).toBe(404);
    // Ce livre-ci, sans empreinte de fichier : rien à faire, et rien demandé à Jellyfin pour lui.
    const before = upstream.mock.calls.length;
    expect((await coverGET(req(), params(BOOK))).status).toBe(404);
    expect(upstream.mock.calls.slice(before).some(([u]) => String(u).includes("/Download"))).toBe(false);
  });
});

describe("GET /api/books/[id]", () => {
  it("le résumé en texte, les genres, la série et le tome", async () => {
    const body = await (await detailGET(req(), params(BOOK))).json();
    expect(body).toMatchObject({ name: "Le grand jeu", seriesName: null, index: null, overview: "Un résumé & plus", genres: ["Aventure"] });
    getDb().prepare("INSERT INTO book_meta (item_id, etag, series, series_index, subjects, failed, checked_at) VALUES (?, 'e', 'Cherub', 10, '[\"Espionnage\"]', 0, 1)").run(BOOK);
    expect(await (await detailGET(req(), params(BOOK))).json()).toMatchObject({ seriesName: "Cherub", index: 10, genres: ["Aventure", "Espionnage"] });
  });
  it("un élément qui n'est pas un livre, hors des droits ou caché par un tag : 404", async () => {
    jellyfinAnswers([bookItem({ Id: MOVIE, Type: "Movie" })]);
    expect((await detailGET(req(), params(MOVIE))).status).toBe(404);
    expect((await detailGET(req(), params(BOOK))).status).toBe(404);
    jellyfinAnswers([bookItem({ Tags: ["prive"] })]);
    blocked.tags = ["prive"];
    expect((await detailGET(req(), params(BOOK))).status).toBe(404);
  });
  it("un identifiant mal formé ne part pas chez Jellyfin", async () => {
    expect((await detailGET(req(), params("../../System/Shutdown"))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("GET /api/books/[id]/file", () => {
  it("relaie le fichier d'un livre visible, en privé, sans rien recopier de Jellyfin", async () => {
    const res = await fileGET(req(), params(BOOK));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/^private/);
    expect(res.headers.get("content-type")).toBe("application/epub+zip");
    expect(res.headers.get("x-emby-authorization")).toBeNull();
    const all = JSON.stringify([...res.headers.entries()]);
    expect(all).not.toContain(KEY);
    expect(await res.text()).toBe("PK\u0003\u0004epub");
    const download = upstream.mock.calls.find(([u]) => String(u).endsWith("/Download")) as [string, RequestInit];
    expect(download[0]).toBe(`http://jf/Items/${BOOK}/Download`);
    expect(new Headers(download[1].headers).get("authorization")).toContain("MediaBrowser");
    expect(new Headers(download[1].headers).get("x-emby-token")).toBeNull();
  });
  it("« Fichier EPUB » (29/10/2026) : le même fichier en pièce jointe « Titre - Auteur.epub », apostrophes et accents encodés", async () => {
    expect((await fileGET(req(), params(BOOK))).headers.get("content-disposition")).toBe("inline");
    jellyfinAnswers([bookItem({ Name: "L'Île au trésor", People: [{ Name: "Robert Louis Stevenson", Type: "Author" }] })]);
    const res = await fileGET(req(undefined, `http://l/api/books/${BOOK}/file?telecharger=1`), params(BOOK));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="L'Ile au tresor - Robert Louis Stevenson.epub"; filename*=UTF-8''L%27%C3%8Ele%20au%20tr%C3%A9sor%20-%20Robert%20Louis%20Stevenson.epub`
    );
  });
  it("ne relaie jamais autre chose qu'un livre : un film demandé ici répond 404 sans téléchargement", async () => {
    jellyfinAnswers([bookItem({ Id: MOVIE, Type: "Movie" })]);
    expect((await fileGET(req(), params(MOVIE))).status).toBe(404);
    expect(upstream.mock.calls.some(([u]) => String(u).endsWith("/Download"))).toBe(false);
  });
  it("un livre caché au compte (tag bloqué, ou refusé par Jellyfin) : 404 sans téléchargement", async () => {
    blocked.tags = ["prive"];
    jellyfinAnswers([bookItem({ Tags: ["prive"] })]);
    expect((await fileGET(req(), params(BOOK))).status).toBe(404);
    jellyfinAnswers([]);
    blocked.tags = [];
    expect((await fileGET(req(), params(BOOK))).status).toBe(404);
    expect(upstream.mock.calls.some(([u]) => String(u).endsWith("/Download"))).toBe(false);
  });
});

describe("la position de lecture", () => {
  const post = (body: unknown) => progressPOST(req(typeof body === "string" ? body : JSON.stringify(body)), params(BOOK));

  it("refuse une position mal formée", async () => {
    expect((await post({ cfi: "javascript:alert(1)", fraction: 0.5 })).status).toBe(400);
    expect((await post({ cfi: "epubcfi(/6/4)", fraction: 2 })).status).toBe(400);
    expect((await post("pas du json")).status).toBe(400);
  });

  it("écrit sous le compte de la session, relue ensuite", async () => {
    expect((await post({ cfi: "epubcfi(/6/4!/4/2)", fraction: 0.25 })).status).toBe(200);
    const { progress } = await (await progressGET(req(), params(BOOK))).json();
    expect(progress).toMatchObject({ cfi: "epubcfi(/6/4!/4/2)", fraction: 0.25, finished: false });
    expect(getDb().prepare("SELECT account FROM book_progress").all()).toEqual([{ account: "lecteur" }]);
    expect(markPlayed).not.toHaveBeenCalled();
  });

  it("« Marquer comme lu » puis « non lu » (29/10/2026) : terminé ici et chez Jellyfin, gardé dans la liste ; puis effacé, signets gardés", async () => {
    await post({ cfi: "epubcfi(/6/8!/4/2)", fraction: 0.3, atStart: false });
    addBookmark("lecteur", BOOK, { cfi: "epubcfi(/6/8!/4/2)", fraction: 0.3, chapter: "II", excerpt: "…" });
    getDb().prepare("INSERT INTO book_list (account, item_id, added_at) VALUES ('lecteur', ?, 1)").run(BOOK);
    expect((await readPOST(req(), params(BOOK))).status).toBe(200);
    expect(markPlayed).toHaveBeenCalledWith(JF, BOOK);
    expect((await (await progressGET(req(), params(BOOK))).json()).progress).toMatchObject({ finished: true });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM book_list").get()).toEqual({ n: 1 });
    expect((await readDELETE(req(), params(BOOK))).status).toBe(200);
    expect(markUnplayed).toHaveBeenCalledWith(JF, BOOK);
    expect((await (await progressGET(req(), params(BOOK))).json()).progress).toBeNull();
    expect(listBookmarks("lecteur", BOOK)).toHaveLength(1);
  });

  it("« Marquer comme lu » un livre jamais ouvert : terminé sans position", async () => {
    expect((await readPOST(req(), params(BOOK))).status).toBe(200);
    expect((await (await progressGET(req(), params(BOOK))).json()).progress).toMatchObject({ finished: true, fraction: 1 });
  });

  it("au bout du livre, « lu » chez Jellyfin pour ce compte — une seule fois", async () => {
    await post({ cfi: "epubcfi(/6/40)", fraction: 1, finished: true });
    await post({ cfi: "epubcfi(/6/40)", fraction: 1, finished: true });
    await post({ cfi: "epubcfi(/6/2)", fraction: 0.1 });
    expect(markPlayed).toHaveBeenCalledTimes(1);
    expect(markPlayed).toHaveBeenCalledWith(JF, BOOK);
    // Revenu au début (une relecture) : « terminé » suit la position depuis le 29/10/2026 — le livre
    // reprendra là ; « lu » chez Jellyfin reste.
    const { progress } = await (await progressGET(req(), params(BOOK))).json();
    expect(progress.finished).toBe(false);
  });

  it("un échec de Jellyfin au « lu » ne perd pas la position", async () => {
    markPlayed.mockRejectedValue(new Error("down"));
    expect((await post({ cfi: "epubcfi(/6/40)", fraction: 1, finished: true })).status).toBe(200);
    expect((await (await progressGET(req(), params(BOOK))).json()).progress.fraction).toBe(1);
  });

  it("un client d'avant `atStart` : sous 1 %, rien n'est écrit — un livre ouvert puis refermé n'est pas commencé", async () => {
    expect(await (await post({ cfi: "epubcfi(/6/2!/4/2)", fraction: 0 })).json()).toMatchObject({ ok: true, notStarted: true });
    expect((await post({ cfi: "epubcfi(/6/2!/4/8)", fraction: 0.004 })).status).toBe(200);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM book_progress").get()).toEqual({ n: 0 });
  });

  it("dès la deuxième page, le livre est commencé — même à 0,3 % d'un long roman ; revenu à la page d'ouverture, il ne l'est plus (29/10/2026)", async () => {
    expect((await (await post({ cfi: "epubcfi(/6/4!/4/2)", fraction: 0.003, atStart: false })).json()).notStarted).toBeUndefined();
    expect((await (await progressGET(req(), params(BOOK))).json()).progress.fraction).toBe(0.003);
    expect(await (await post({ cfi: "epubcfi(/6/4!/4/1)", fraction: 0.002, atStart: true })).json()).toMatchObject({ notStarted: true });
    expect((await (await progressGET(req(), params(BOOK))).json()).progress).toBeNull();
  });

  it("revenu à la première page puis refermé : redevient « pas commencé », les signets restent", async () => {
    await post({ cfi: "epubcfi(/6/8!/4/2)", fraction: 0.3 });
    addBookmark("lecteur", BOOK, { cfi: "epubcfi(/6/8!/4/2)", fraction: 0.3, chapter: "II", excerpt: "…" });
    await post({ cfi: "epubcfi(/6/2!/4/2)", fraction: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM book_progress").get()).toEqual({ n: 0 });
    expect((await (await progressGET(req(), params(BOOK))).json()).progress).toBeNull();
    expect(listBookmarks("lecteur", BOOK)).toHaveLength(1);
  });

  it("un livre terminé revenu à sa première page reste lu", async () => {
    await post({ cfi: "epubcfi(/6/40)", fraction: 1, finished: true });
    await post({ cfi: "epubcfi(/6/2)", fraction: 0 });
    expect((await (await progressGET(req(), params(BOOK))).json()).progress).toMatchObject({ finished: true, fraction: 1 });
  });

  it("ne s'écrit pas sur un élément que le compte ne voit pas", async () => {
    jellyfinAnswers([]);
    expect((await post({ cfi: "epubcfi(/6/4)", fraction: 0.5 })).status).toBe(404);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM book_progress").get()).toEqual({ n: 0 });
  });
});
