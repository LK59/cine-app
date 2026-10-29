// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { NextRequest } from "next/server";

/**
 * Lire, de bout en bout (DECISIONS.md §127) : toucher les bords ou non, les signets (gardés par compte,
 * côté serveur), la file des écritures faites sans réseau, et la section des livres de la page des
 * téléchargements — absente, et sans rien charger, quand l'appareil n'en garde pas.
 */
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "laterna-books-reading-"));
});
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "k" }, books: { enabled: true } } }));
const visible = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/books/library", () => ({ bookFor: async () => (visible.ok ? { id: "x" } : null), forgetPlayed: () => {} }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { markPlayed: async () => {} } }));
const swr = vi.hoisted(() => ({ data: undefined as unknown, error: undefined as unknown }));
vi.mock("swr", () => ({ default: () => ({ data: swr.data, error: swr.error }) }));
const downloadsLoaded = vi.hoisted(() => vi.fn());
vi.mock("@/components/books/BooksDownloads", () => {
  downloadsLoaded();
  return { BooksDownloads: () => <div data-downloads-books /> };
});
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

import { tapAction, normalizeReaderPrefs, TAP_EDGE } from "@/lib/books/readerPrefs";
import { GET as marksGET, POST as marksPOST } from "@/app/api/books/[id]/bookmarks/route";
import { POST as progressPOST, GET as progressGET } from "@/app/api/books/[id]/progress/route";
import { MAX_BOOKMARKS } from "@/lib/books/bookmarks";
import { beaconProgress, flushOutbox, mergeBookmarks, outbox, pendingBookmarks, rememberedPosition, sendBookOp } from "@/lib/books/bookSync";
import { BooksDownloadsEntry, useOfflineBooksPresent } from "@/components/books/BooksMode";
import { getDb } from "@/lib/db";

const BOOK = "a".repeat(32);
const req = (body?: unknown) =>
  ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers(), nextUrl: new URL("http://l/x"), text: async () => (body === undefined ? "" : JSON.stringify(body)) }) as unknown as NextRequest;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  verify.mockResolvedValue({ u: "lecteur", role: "user", jfId: "j", jti: "t" });
  visible.ok = true;
  localStorage.clear();
  getDb().prepare("DELETE FROM book_bookmarks").run();
  getDb().prepare("DELETE FROM book_progress").run();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("toucher la page", () => {
  it("les bords tournent la page (30 % de chaque côté), le milieu montre ou cache les barres", () => {
    expect(TAP_EDGE).toBe(0.3);
    expect(tapAction(29, 100, true, false)).toBe("left");
    expect(tapAction(71, 100, true, false)).toBe("right");
    expect(tapAction(50, 100, true, false)).toBe("show");
    expect(tapAction(50, 100, true, true)).toBe("hide");
  });
  it("réglage coupé : un toucher ne tourne jamais la page, où qu'il tombe", () => {
    for (const x of [0, 10, 50, 90, 100]) expect(["show", "hide"]).toContain(tapAction(x, 100, false, x > 50));
  });
  it("allumé par défaut, gardé par l'appareil comme les autres réglages", () => {
    expect(normalizeReaderPrefs({}).tapTurns).toBe(true);
    expect(normalizeReaderPrefs({ tapTurns: false }).tapTurns).toBe(false);
    expect(normalizeReaderPrefs({ tapTurns: "non" }).tapTurns).toBe(true);
  });
});

describe("les signets, côté serveur", () => {
  it("par compte : posés, listés dans l'ordre du livre, retirés ; un autre compte ne les voit pas", async () => {
    const at = (f: number) => ({ cfi: `epubcfi(/6/${Math.round(f * 100) * 2}!/4/2/1:0)`, fraction: f, chapter: "Chapitre", excerpt: "Il était une fois\u0000 un  livre" });
    expect((await marksPOST(req(at(0.5)), params(BOOK))).status).toBe(200);
    const res = await marksPOST(req(at(0.2)), params(BOOK));
    const { bookmarks } = await res.json();
    expect(bookmarks.map((b: { fraction: number }) => b.fraction)).toEqual([0.2, 0.5]);
    expect(bookmarks[0].excerpt).toBe("Il était une fois un livre");
    verify.mockResolvedValue({ u: "autre", role: "user", jfId: "k", jti: "u" });
    expect((await (await marksGET(req(), params(BOOK))).json()).bookmarks).toEqual([]);
    verify.mockResolvedValue({ u: "lecteur", role: "user", jfId: "j", jti: "t" });
    await marksPOST(req({ cfi: at(0.2).cfi, remove: true }), params(BOOK));
    expect((await (await marksGET(req(), params(BOOK))).json()).bookmarks).toHaveLength(1);
  });
  it("refusés : une adresse qui n'est pas une CFI, un livre que le compte ne voit pas, un lien de partage", async () => {
    expect((await marksPOST(req({ cfi: "javascript:1", fraction: 0.1 }), params(BOOK))).status).toBe(400);
    visible.ok = false;
    expect((await marksPOST(req({ cfi: "epubcfi(/6/2)", fraction: 0.1 }), params(BOOK))).status).toBe(404);
    verify.mockResolvedValue({ u: "partage", role: "share", sh: "s", jti: "j" });
    expect((await marksGET(req(), params(BOOK))).status).toBe(404);
  });
  it("bornés par livre", async () => {
    const insert = getDb().prepare("INSERT INTO book_bookmarks VALUES (?, ?, ?, ?, '', '', ?)");
    for (let i = 0; i < MAX_BOOKMARKS; i++) insert.run("lecteur", BOOK, `epubcfi(/6/${i})`, i / MAX_BOOKMARKS, i);
    await marksPOST(req({ cfi: "epubcfi(/6/99999)", fraction: 0.99 }), params(BOOK));
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM book_bookmarks WHERE account = 'lecteur'").get() as { n: number }).n;
    expect(n).toBe(MAX_BOOKMARKS);
  });
});

describe("une position lue hors ligne, renvoyée plus tard", () => {
  it("n'efface pas celle, plus récente, qu'un autre appareil a écrite entre-temps", async () => {
    getDb().prepare("INSERT INTO book_progress (account, item_id, cfi, fraction, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)").run("lecteur", BOOK, "epubcfi(/6/20)", 0.6, 2000, null);
    await progressPOST(req({ cfi: "epubcfi(/6/4)", fraction: 0.1, at: 1000 }), params(BOOK));
    expect((await (await progressGET(req(), params(BOOK))).json()).progress.cfi).toBe("epubcfi(/6/20)");
    await progressPOST(req({ cfi: "epubcfi(/6/30)", fraction: 0.8, at: Date.now() }), params(BOOK));
    expect((await (await progressGET(req(), params(BOOK))).json()).progress.cfi).toBe("epubcfi(/6/30)");
  });
});

describe("l'heure d'une position, dans l'horloge du serveur (29/10/2026)", () => {
  it("un appareil qui retarde d'une minute n'a plus ses positions jetées", async () => {
    getDb().prepare("INSERT OR REPLACE INTO book_progress (account, item_id, cfi, fraction, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)").run("lecteur", BOOK, "epubcfi(/6/20)", 0.3, Date.now() - 2000, null);
    const res = await progressPOST(req({ cfi: "epubcfi(/6/22)", fraction: 0.31, at: Date.now() - 60_000, ageMs: 0 }), params(BOOK));
    expect((await res.json()).kept).toBeUndefined();
    expect((await (await progressGET(req(), params(BOOK))).json()).progress.cfi).toBe("epubcfi(/6/22)");
  });
  it("un appareil qui avance ne remet pas dans la rangée un livre retiré après sa lecture", async () => {
    getDb().prepare("INSERT OR REPLACE INTO book_progress (account, item_id, cfi, fraction, updated_at, finished_at, dismissed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("lecteur", BOOK, "epubcfi(/6/20)", 0.3, Date.now() - 60_000, null, Date.now() - 1000);
    const res = await progressPOST(req({ cfi: "epubcfi(/6/24)", fraction: 0.32, at: Date.now() + 120_000, ageMs: 30_000 }), params(BOOK));
    expect((await res.json()).kept).toBe(true);
  });
  it("le serveur dit son heure avec la position", async () => {
    const body = await (await progressGET(req(), params(BOOK))).json();
    expect(Math.abs(body.now - Date.now())).toBeLessThan(5000);
  });
});

describe("la file de l'appareil", () => {
  it("une session expirée (401) garde l'écriture pour après la reconnexion, et l'âge part avec la position", async () => {
    const fetchSpy = vi.fn(async (_u: string, _i?: RequestInit) => new Response("", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);
    await sendBookOp({ kind: "progress", id: BOOK, body: { cfi: "epubcfi(/6/10)", fraction: 0.4, finished: false, at: Date.now() - 5000 } });
    expect(outbox()).toHaveLength(1);
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(sent.ageMs).toBeGreaterThanOrEqual(5000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await flushOutbox();
    expect(outbox()).toEqual([]);
  });
  it("sans réseau : position et signets attendent ; une seule position par livre ; repartent au retour", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false, sendBeacon: vi.fn() });
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await sendBookOp({ kind: "progress", id: BOOK, body: { cfi: "epubcfi(/6/2)", fraction: 0.1, finished: false, at: 1 } });
    beaconProgress(BOOK, { cfi: "epubcfi(/6/4)", fraction: 0.2, finished: false, at: 2 });
    await sendBookOp({ kind: "bookmark", id: BOOK, body: { cfi: "epubcfi(/6/4)", fraction: 0.2 } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outbox().filter((o) => o.kind === "progress")).toHaveLength(1);
    expect(rememberedPosition(BOOK)?.cfi).toBe("epubcfi(/6/4)");
    expect(pendingBookmarks(BOOK)).toHaveLength(1);
    vi.stubGlobal("navigator", { ...navigator, onLine: true });
    await flushOutbox();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(outbox()).toEqual([]);
  });
  it("une panne du serveur (5xx) garde l'écriture ; un refus (4xx) ne la retente pas", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await sendBookOp({ kind: "bookmark", id: BOOK, body: { cfi: "epubcfi(/6/8)", fraction: 0.3 } });
    expect(outbox()).toHaveLength(1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));
    await flushOutbox();
    expect(outbox()).toEqual([]);
  });
  it("la liste montrée : celle du serveur, plus les ajouts et moins les retraits pas encore partis", () => {
    const server = [
      { cfi: "a", fraction: 0.5, chapter: "", excerpt: "", createdAt: 1 },
      { cfi: "b", fraction: 0.1, chapter: "", excerpt: "", createdAt: 1 },
    ];
    expect(mergeBookmarks(server, [{ cfi: "b", remove: true }, { cfi: "c", fraction: 0.3 }]).map((b) => b.cfi)).toEqual(["c", "a"]);
  });
});

describe("la page des téléchargements", () => {
  function Probe() {
    const present = useOfflineBooksPresent();
    return <BooksDownloadsEntry present={present} />;
  }
  it("aucun livre sur l'appareil : rien, et rien des livres chargé", async () => {
    swr.data = { booksEnabled: true };
    const { container } = render(<Probe />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe("");
    expect(downloadsLoaded).not.toHaveBeenCalled();
  });
  it("des livres sur l'appareil, mais plus affichés pour ce compte : rien", async () => {
    localStorage.setItem("laterna:books:offline-count", "2");
    swr.data = { booksEnabled: false };
    const { container } = render(<Probe />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe("");
  });
  it("des livres sur l'appareil, et sans réseau : le dernier état connu décide", async () => {
    localStorage.setItem("laterna:books:offline-count", "2");
    localStorage.setItem("laterna:books:shown", "1");
    swr.data = undefined;
    swr.error = new Error("hors ligne");
    const { container } = render(<Probe />);
    await vi.waitFor(() => expect(container.querySelector("[data-downloads-books]")).not.toBeNull());
    swr.error = undefined;
  });
});
