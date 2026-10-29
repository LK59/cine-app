import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import type { NextRequest } from "next/server";

/**
 * Les trois ajouts des livres du 29/10/2026 (DECISIONS.md §129), côté serveur :
 *
 * - les réglages du lecteur par compte et par type d'appareil — validés champ par champ, un type sans
 *   réglages prend les derniers écrits du compte, puis garde les siens ; jamais ceux d'un autre compte ;
 * - le journal des lectures (`lectures.log`) — une séance bornée, nommée par le serveur, et les lignes
 *   « terminé » / « retiré » ; l'appareil de la dernière page dans `book_progress` ; la vue de l'activité
 *   réservée à l'administrateur et absente l'option coupée ;
 * - « Ma liste de lecture » — un livre que le compte ne voit pas ne s'y ajoute pas, et un livre terminé
 *   y reste, comme un film vu dans « À voir ».
 */
await vi.hoisted(async () => {
  const f = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = f.mkdtempSync(p.join(os.tmpdir(), "laterna-books-lectures-"));
});
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
const cfg = vi.hoisted(() => ({ on: true }));
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
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { markPlayed: async () => undefined } }));

import { GET as prefsGET, PUT as prefsPUT } from "@/app/api/books/reader-prefs/route";
import { POST as sessionPOST } from "@/app/api/books/[id]/session/route";
import { POST as progressPOST, DELETE as progressDELETE } from "@/app/api/books/[id]/progress/route";
import { GET as listGET, POST as listPOST, DELETE as listDELETE } from "@/app/api/books/list/route";
import { GET as homeGET } from "@/app/api/books/home/route";
import { GET as adminGET } from "@/app/api/admin/activity/books/route";
import { __testing as indexTesting } from "@/lib/books/bookIndex";
import { __testing as rightsTesting } from "@/lib/books/rights";
import { __testing as logTesting } from "@/lib/activity/logReader";
import { getDb } from "@/lib/db";
import { READINGS_LOG } from "@/lib/eventLogs";
import { defaultReaderPrefs } from "@/lib/books/readerPrefs";
import { deviceTypeOf } from "@/lib/books/deviceType";
import { validReadingSession } from "@/lib/books/readingLog";

const BOOK = "a".repeat(32);
const HIDDEN = "d".repeat(32);
const JF = "c".repeat(32);
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const req = (body?: string, url = "http://l/api/books", ua = IPHONE) =>
  ({
    cookies: { get: () => ({ value: "t" }) },
    headers: new Headers({ "user-agent": ua }),
    nextUrl: new URL(url),
    signal: new AbortController().signal,
    text: async () => body ?? "",
  }) as unknown as NextRequest;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const item = (id: string, name: string, tags: string[] = []) => ({
  Id: id,
  Name: name,
  Type: "Book",
  ImageTags: {},
  Tags: tags,
  Genres: [],
  People: [{ Name: "Ursula K. Le Guin", Type: "Author" }],
  UserData: { Played: false },
});

beforeEach(() => {
  vi.clearAllMocks();
  cfg.on = true;
  blocked.tags = ["prive"];
  verify.mockResolvedValue({ u: "lecteur", jfUser: "lecteur", role: "user", jfId: JF, jti: "j" });
  rightsTesting.reset();
  indexTesting.reset();
  logTesting.reset();
  for (const table of ["book_progress", "book_reader_prefs", "book_list"]) getDb().prepare(`DELETE FROM ${table}`).run();
  fs.rmSync(READINGS_LOG(), { force: true });
  const items = [item(BOOK, "Terremer"), item(HIDDEN, "Le Livre caché", ["prive"])];
  upstream.mockImplementation(async (url: string) => {
    if (url.endsWith("/Library/VirtualFolders")) return json([{ ItemId: "1".repeat(32), CollectionType: "books" }]);
    if (url.endsWith(`/Users/${JF}`)) return json({ Policy: { EnableAllFolders: true } });
    const one = /\/Items\/([0-9a-f]{32})\?/.exec(url)?.[1];
    if (one) {
      const found = items.find((i) => i.Id === one);
      return found ? json(found) : json({}, 404);
    }
    if (new URL(url).searchParams.get("IsPlayed") === "true") return json({ Items: [] });
    return json({ Items: items, TotalRecordCount: items.length });
  });
});

const readLines = () =>
  fs.existsSync(READINGS_LOG())
    ? fs
        .readFileSync(READINGS_LOG(), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe("le type d'appareil", () => {
  it("tactile et petit écran : téléphone ; tactile et grand : tablette ; le reste, Fire TV comprise : ordinateur", () => {
    expect(deviceTypeOf({ touch: true, shortSide: 390 })).toBe("telephone");
    expect(deviceTypeOf({ touch: true, shortSide: 820 })).toBe("tablette");
    expect(deviceTypeOf({ touch: false, shortSide: 390 })).toBe("ordinateur");
    expect(deviceTypeOf({ touch: true, shortSide: 1080, fireTv: true })).toBe("ordinateur");
  });
});

describe("les réglages du lecteur, par compte et par type d'appareil", () => {
  const put = (body: unknown) => prefsPUT(req(typeof body === "string" ? body : JSON.stringify(body)));
  const get = async (device: string) => {
    const res = await prefsGET(req(undefined, `http://l/api/books/reader-prefs?device=${device}`));
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as { prefs: Record<string, unknown> | null; own?: boolean; from?: string }) : null };
  };
  const prefs = (over: Record<string, unknown> = {}) => ({ ...defaultReaderPrefs(), ...over });

  it("refuse un type inconnu, un champ en trop, un choix hors liste, un nombre hors bornes, un corps trop long", async () => {
    expect((await get("television")).status).toBe(400);
    expect((await put({ device: "television", prefs: prefs() })).status).toBe(400);
    expect((await put({ device: "telephone", prefs: { ...prefs(), extra: 1 } })).status).toBe(400);
    const { tapTurns: _dropped, ...partial } = prefs();
    void _dropped;
    expect((await put({ device: "telephone", prefs: partial })).status).toBe(400);
    expect((await put({ device: "telephone", prefs: prefs({ theme: "rose" }) })).status).toBe(400);
    expect((await put({ device: "telephone", prefs: prefs({ fontSize: 500 }) })).status).toBe(400);
    expect((await put({ device: "telephone", prefs: prefs({ brightness: "1" }) })).status).toBe(400);
    expect((await put({ device: "telephone", prefs: prefs({ justify: "oui" }) })).status).toBe(400);
    expect((await put("pas du json")).status).toBe(400);
    expect((await put(JSON.stringify({ device: "telephone", prefs: prefs(), pad: "x".repeat(3000) }))).status).toBe(413);
    // Rien n'a été écrit.
    expect((await get("telephone")).body?.prefs).toBeNull();
  });

  it("un type sans réglages prend les derniers écrits du compte ; une fois les siens écrits, il les garde", async () => {
    expect((await put({ device: "telephone", prefs: prefs({ theme: "sepia" }) })).status).toBe(200);
    // La tablette et l'ordinateur n'ont rien : ceux du téléphone, les seuls du compte.
    expect((await get("tablette")).body).toMatchObject({ prefs: { theme: "sepia" }, own: false, from: "telephone" });
    expect((await get("ordinateur")).body).toMatchObject({ prefs: { theme: "sepia" }, own: false });
    // L'ordinateur règle les siens : il les garde, même quand le téléphone change ensuite.
    await put({ device: "ordinateur", prefs: prefs({ theme: "dark", fontSize: 130 }), ageMs: 1000 });
    await put({ device: "telephone", prefs: prefs({ theme: "black" }) });
    expect((await get("ordinateur")).body).toMatchObject({ prefs: { theme: "dark", fontSize: 130 }, own: true });
    expect((await get("telephone")).body).toMatchObject({ prefs: { theme: "black" }, own: true });
    // La tablette, toujours sans les siens, suit les derniers écrits — ceux du téléphone, plus récents.
    expect((await get("tablette")).body).toMatchObject({ prefs: { theme: "black" }, own: false, from: "telephone" });
  });

  it("un changement renvoyé tard (hors ligne) n'écrase pas un plus récent du même type", async () => {
    await put({ device: "telephone", prefs: prefs({ theme: "light" }) });
    const res = await put({ device: "telephone", prefs: prefs({ theme: "dark" }), ageMs: 60_000 });
    expect(await res.json()).toMatchObject({ ok: true, kept: true });
    expect((await get("telephone")).body?.prefs).toMatchObject({ theme: "light" });
  });

  it("un compte ne voit jamais les réglages d'un autre", async () => {
    await put({ device: "telephone", prefs: prefs({ theme: "sepia" }) });
    verify.mockResolvedValue({ u: "voisin", role: "user", jfId: "e".repeat(32), jti: "k" });
    expect((await get("telephone")).body?.prefs).toBeNull();
    expect((await get("ordinateur")).body?.prefs).toBeNull();
  });

  it("option coupée : 404 ; lien de partage : 404", async () => {
    cfg.on = false;
    expect((await get("telephone")).status).toBe(404);
    expect((await put({ device: "telephone", prefs: prefs() })).status).toBe(404);
    cfg.on = true;
    verify.mockResolvedValue({ u: "partage", role: "share", sh: "s", jti: "j" });
    expect((await get("telephone")).status).toBe(404);
  });
});

describe("le journal des lectures", () => {
  const session = (over: Record<string, unknown> = {}, id = BOOK) =>
    sessionPOST(req(JSON.stringify({ durationMs: 120_000, fromFraction: 0.1, toFraction: 0.2, pages: 14, offline: false, deviceType: "telephone", id: `s-${Math.random()}`, build: "abc1234", version: "10.10.7", ...over })), params(id));

  it("valide et borne une séance", () => {
    expect(validReadingSession({ durationMs: -1, fromFraction: 0, toFraction: 0, pages: 0 })).toBeNull();
    expect(validReadingSession({ durationMs: 13 * 3_600_000, fromFraction: 0, toFraction: 0, pages: 0 })).toBeNull();
    expect(validReadingSession({ durationMs: 1000, fromFraction: 1.5, toFraction: 0, pages: 0 })).toBeNull();
    expect(validReadingSession({ durationMs: 1000, fromFraction: 0, toFraction: 0, pages: 1.5 })).toBeNull();
    expect(validReadingSession({ durationMs: 1000, fromFraction: 0, toFraction: 0, pages: 1, ageMs: 40 * 86_400_000 })).toBeNull();
    // Un identifiant ou un build forgés (espaces, balises) sont laissés, la séance non.
    expect(validReadingSession({ durationMs: 1000, fromFraction: 0, toFraction: 0, pages: 1, id: "<script>", build: "a b" })).toMatchObject({ id: null, build: null });
  });

  it("une ligne par séance : le compte de la session, le titre et l'auteur lus par le serveur, l'appareil", async () => {
    expect((await session({ title: "Forgé", account: "quelqu'un d'autre" })).status).toBe(204);
    const [line] = readLines();
    expect(line).toMatchObject({ kind: "séance", user: "lecteur", account: "lecteur", book: BOOK, title: "Terremer", author: "Ursula K. Le Guin", deviceType: "telephone", durationMs: 120_000, pages: 14, offline: false });
    expect(String(line.device)).toMatch(/iPhone/);
    expect(Date.parse(String(line.endedAt)) - Date.parse(String(line.startedAt))).toBe(120_000);
  });

  it("rien sous dix secondes sans page tournée ; une séance hors ligne renvoyée tard porte son retard ; une séance renvoyée deux fois n'est écrite qu'une fois", async () => {
    expect((await session({ durationMs: 4000, pages: 0 })).status).toBe(204);
    expect(readLines()).toHaveLength(0);
    await session({ offline: true, ageMs: 3 * 3_600_000, id: "hors-ligne-1" });
    await session({ offline: true, ageMs: 3 * 3_600_000, id: "hors-ligne-1" });
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ offline: true, resent: true, lateByMs: 3 * 3_600_000 });
  });

  it("un livre hors des droits du compte n'a pas de séance ; un corps invalide est refusé", async () => {
    expect((await session({}, HIDDEN)).status).toBe(404);
    expect((await session({ durationMs: "long" })).status).toBe(400);
    expect(readLines()).toHaveLength(0);
  });

  it("le livre terminé la première fois et le retrait de « Continuer la lecture » ont leur ligne ; la position garde l'appareil", async () => {
    const pos = (fraction: number, finished = false) => progressPOST(req(JSON.stringify({ cfi: "epubcfi(/6/4!/4/2)", fraction, finished })), params(BOOK));
    expect((await pos(0.4)).status).toBe(200);
    expect(getDb().prepare("SELECT last_device FROM book_progress WHERE account = ?").get("lecteur")).toMatchObject({ last_device: expect.stringMatching(/iPhone/) });
    expect((await progressDELETE(req(), params(BOOK))).status).toBe(200);
    await pos(1, true);
    await pos(1, true);
    const kinds = readLines().map((l) => l.kind);
    expect(kinds).toEqual(["retiré", "terminé"]);
    expect(readLines()[1]).toMatchObject({ title: "Terremer", account: "lecteur" });
  });
});

describe("« Lectures » dans l'activité", () => {
  it("à l'administrateur seul ; absente l'option coupée", async () => {
    expect((await adminGET(req())).status).toBe(403);
    verify.mockResolvedValue({ u: "admin", role: "admin", jti: "a" });
    cfg.on = false;
    expect((await adminGET(req())).status).toBe(404);
    cfg.on = true;
    expect((await adminGET(req())).status).toBe(200);
  });

  it("par compte : en cours (avec l'appareil), terminés, temps de lecture sur sept jours", async () => {
    await progressPOST(req(JSON.stringify({ cfi: "epubcfi(/6/4!/4/2)", fraction: 0.5 })), params(BOOK));
    await sessionPOST(req(JSON.stringify({ durationMs: 600_000, fromFraction: 0.4, toFraction: 0.5, pages: 30, id: "x1" })), params(BOOK));
    verify.mockResolvedValue({ u: "admin", role: "admin", jti: "a" });
    const data = (await (await adminGET(req())).json()) as { accounts: { account: string; inProgress: { title: string; device: string; fraction: number }[]; week: { ms: number; sessions: number } }[] };
    const reader = data.accounts.find((a) => a.account === "lecteur");
    expect(reader?.inProgress[0]).toMatchObject({ title: "Terremer", fraction: 0.5, device: expect.stringMatching(/iPhone/) });
    expect(reader?.week).toEqual({ ms: 600_000, sessions: 1 });
  });
});

describe("« Ma liste de lecture »", () => {
  const add = (id: string) => listPOST(req(JSON.stringify({ id })));
  const list = async () => ((await (await listGET(req())).json()) as { books: { id: string; name: string }[] }).books.map((b) => b.id);

  it("ajouter, lire, retirer — sous le compte de la session seulement", async () => {
    expect((await add(BOOK)).status).toBe(200);
    expect((await add(BOOK)).status).toBe(200);
    expect(await list()).toEqual([BOOK]);
    verify.mockResolvedValue({ u: "voisin", role: "user", jfId: JF, jti: "k" });
    expect(await list()).toEqual([]);
    verify.mockResolvedValue({ u: "lecteur", role: "user", jfId: JF, jti: "j" });
    expect((await listDELETE(req(undefined, `http://l/api/books/list?id=${BOOK}`))).status).toBe(200);
    expect(await list()).toEqual([]);
  });

  it("un livre que le compte ne voit pas (tag bloqué) ne s'ajoute pas ; un identifiant mal formé non plus", async () => {
    expect((await add(HIDDEN)).status).toBe(404);
    expect((await add("pas-un-id")).status).toBe(400);
    // Une ligne écrite avant le tag bloqué ne paraît pas.
    getDb().prepare("INSERT INTO book_list (account, item_id, added_at) VALUES (?, ?, ?)").run("lecteur", HIDDEN, Date.now());
    expect(await list()).toEqual([]);
  });

  it("un livre terminé reste dans la liste ; l'accueil des livres la montre juste après « Continuer la lecture »", async () => {
    await add(BOOK);
    const home = (await (await homeGET(req())).json()) as { list: { id: string }[] };
    expect(home.list.map((b) => b.id)).toEqual([BOOK]);
    await progressPOST(req(JSON.stringify({ cfi: "epubcfi(/6/4!/4/2)", fraction: 1, finished: true })), params(BOOK));
    expect(await list()).toEqual([BOOK]);
  });

  it("option coupée : 404", async () => {
    cfg.on = false;
    expect((await listGET(req())).status).toBe(404);
    expect((await add(BOOK)).status).toBe(404);
  });
});
