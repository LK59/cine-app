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
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { markPlayed: (...a: unknown[]) => markPlayed(...a) } }));

import { GET as listGET } from "@/app/api/books/route";
import { GET as detailGET } from "@/app/api/books/[id]/route";
import { GET as fileGET } from "@/app/api/books/[id]/file/route";
import { GET as progressGET, POST as progressPOST } from "@/app/api/books/[id]/progress/route";
import { getDb } from "@/lib/db";

const BOOK = "a".repeat(32);
const MOVIE = "b".repeat(32);
const JF = "c".repeat(32);
const req = (body?: string) =>
  ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers(), signal: new AbortController().signal, text: async () => body ?? "" }) as unknown as NextRequest;
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

/** Ce que Jellyfin répond, selon l'adresse demandée. */
function jellyfinAnswers(items: Record<string, unknown>[], file = "PK\u0003\u0004epub") {
  upstream.mockImplementation(async (url: string) => {
    if (url.endsWith("/Download")) return new Response(file, { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(file.length), "X-Emby-Authorization": "leak" } });
    const one = /\/Items\/([0-9a-f]{32})\?/.exec(url)?.[1];
    if (one) {
      const item = items.find((i) => i.Id === one);
      return item ? json(item) : json({}, 404);
    }
    return json({ Items: items, TotalRecordCount: items.length });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cfg.on = true;
  blocked.tags = [];
  verify.mockResolvedValue({ u: "lecteur", role: "user", jfId: JF, jti: "j" });
  markPlayed.mockResolvedValue(undefined);
  getDb().prepare("DELETE FROM book_progress").run();
  getDb().prepare("DELETE FROM book_meta").run();
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
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404]);
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
  it("demande à Jellyfin sous l'identité du compte, signé par l'en-tête MediaBrowser seulement", async () => {
    await listGET(req());
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`http://jf/Users/${JF}/Items?`);
    expect(url).toContain("IncludeItemTypes=Book");
    expect(url).toContain("Recursive=true");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toContain(`MediaBrowser Token="${KEY}"`);
    expect(headers.get("x-emby-token")).toBeNull();
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
    getDb().prepare("INSERT INTO book_progress VALUES (?, ?, ?, ?, ?, ?)").run("lecteur", BOOK, "epubcfi(/6/2)", 0.4, 1, null);
    getDb().prepare("INSERT INTO book_progress VALUES (?, ?, ?, ?, ?, ?)").run("autre", BOOK, "epubcfi(/6/8)", 0.9, 1, null);
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

  it("au bout du livre, « lu » chez Jellyfin pour ce compte — une seule fois", async () => {
    await post({ cfi: "epubcfi(/6/40)", fraction: 1, finished: true });
    await post({ cfi: "epubcfi(/6/40)", fraction: 1, finished: true });
    await post({ cfi: "epubcfi(/6/2)", fraction: 0.1 });
    expect(markPlayed).toHaveBeenCalledTimes(1);
    expect(markPlayed).toHaveBeenCalledWith(JF, BOOK);
    const { progress } = await (await progressGET(req(), params(BOOK))).json();
    expect(progress.finished).toBe(true);
  });

  it("un échec de Jellyfin au « lu » ne perd pas la position", async () => {
    markPlayed.mockRejectedValue(new Error("down"));
    expect((await post({ cfi: "epubcfi(/6/40)", fraction: 1, finished: true })).status).toBe(200);
    expect((await (await progressGET(req(), params(BOOK))).json()).progress.fraction).toBe(1);
  });

  it("ne s'écrit pas sur un élément que le compte ne voit pas", async () => {
    jellyfinAnswers([]);
    expect((await post({ cfi: "epubcfi(/6/4)", fraction: 0.5 })).status).toBe(404);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM book_progress").get()).toEqual({ n: 0 });
  });
});
