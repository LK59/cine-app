import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * « Demander un livre » (option, DECISIONS.md §127) : un ticket, traité à la main. Coupé — livres ou
 * demandes —, rien n'existe ; un lien de partage n'y a jamais accès ; chacun ne voit que les siennes,
 * l'administrateur toutes ; les notifications passent par le chemin des signalements.
 */
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "laterna-books-requests-"));
});
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
const cfg = vi.hoisted(() => ({ books: true, requests: true }));
vi.mock("@/lib/config", () => ({
  config: {
    app: { language: "fr" },
    jellyfin: { url: "http://jf", apiKey: "k" },
    books: {
      get enabled() {
        return cfg.books;
      },
      get requests() {
        return cfg.books && cfg.requests;
      },
    },
  },
}));
const push = vi.hoisted(() => ({ admins: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushToAdmins: (...a: unknown[]) => push.admins(...a), sendPushToUser: (...a: unknown[]) => push.user(...a) }));

import { GET, POST } from "@/app/api/books/requests/route";
import { PATCH } from "@/app/api/books/requests/[id]/route";
import { __testing } from "@/lib/books/requests";
import { getDb } from "@/lib/db";

const req = (body?: unknown) =>
  ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers(), text: async () => (body === undefined ? "" : JSON.stringify(body)), json: async () => body }) as unknown as NextRequest;
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const asUser = (u = "lecteur") => verify.mockResolvedValue({ u, role: "user", jfId: "a".repeat(32), jti: "j" });
const asAdmin = () => verify.mockResolvedValue({ u: "admin", role: "admin", jfId: "b".repeat(32), jti: "j" });

beforeEach(() => {
  vi.clearAllMocks();
  cfg.books = true;
  cfg.requests = true;
  push.admins.mockResolvedValue(undefined);
  push.user.mockResolvedValue(undefined);
  getDb().prepare("DELETE FROM book_requests").run();
  asUser();
});

describe("coupées", () => {
  it.each([
    ["les livres coupés", { books: false, requests: true }],
    ["les demandes coupées", { books: true, requests: false }],
  ])("%s : 404 partout, rien d'écrit", async (_, state) => {
    Object.assign(cfg, state);
    expect((await GET(req())).status).toBe(404);
    expect((await POST(req({ title: "Dune" }))).status).toBe(404);
    asAdmin();
    expect((await PATCH(req({ status: "added" }), params(1))).status).toBe(404);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM book_requests").get()).toEqual({ n: 0 });
  });
  it("un lien de partage n'y a jamais accès", async () => {
    verify.mockResolvedValue({ u: "partage", role: "share", sh: "s", jti: "j" });
    expect((await POST(req({ title: "Dune" }))).status).toBe(404);
    expect((await GET(req())).status).toBe(404);
  });
});

describe("demander", () => {
  it("un compte ordinaire demande pour lui-même ; les administrateurs sont prévenus", async () => {
    const res = await POST(req({ title: "  Dune  ", author: "Frank Herbert", note: "Tome 1, en français" }));
    expect(res.status).toBe(201);
    const { request } = await res.json();
    expect(request).toMatchObject({ account: "lecteur", title: "Dune", author: "Frank Herbert", status: "pending" });
    await __testing.drain();
    expect(push.admins).toHaveBeenCalledWith(expect.objectContaining({ category: "report-new", url: "/livres?demandes=1" }));
  });
  it("refuse un titre absent, un texte trop long, un type faux", async () => {
    expect((await POST(req({ title: "   " }))).status).toBe(400);
    expect((await POST(req({ title: "x".repeat(201) }))).status).toBe(400);
    expect((await POST(req({ title: "Dune", note: "x".repeat(1001) }))).status).toBe(400);
    expect((await POST(req({ title: 42 }))).status).toBe(400);
  });
  it("vingt par jour et par compte", async () => {
    for (let i = 0; i < 20; i++) expect((await POST(req({ title: `Livre ${i}` }))).status).toBe(201);
    expect((await POST(req({ title: "Un de trop" }))).status).toBe(429);
    asUser("autre");
    expect((await POST(req({ title: "Le sien" }))).status).toBe(201);
  });
});

describe("voir et répondre", () => {
  it("chacun ne voit que les siennes ; l'administrateur toutes", async () => {
    await POST(req({ title: "À moi" }));
    asUser("autre");
    await POST(req({ title: "À l'autre" }));
    const mine = await (await GET(req())).json();
    expect(mine.mine.map((r: { title: string }) => r.title)).toEqual(["À l'autre"]);
    expect(mine.all).toBeUndefined();
    asAdmin();
    const admin = await (await GET(req())).json();
    expect(admin.all).toHaveLength(2);
  });
  it("seul l'administrateur répond ; qui a demandé est prévenu, dans la langue de chaque appareil", async () => {
    const { request } = await (await POST(req({ title: "Dune" }))).json();
    expect((await PATCH(req({ status: "added" }), params(request.id))).status).toBe(403);
    asAdmin();
    const res = await PATCH(req({ status: "added", reply: "Dans la bibliothèque" }), params(request.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request).toMatchObject({ status: "added", reply: "Dans la bibliothèque" });
    expect(body.request.userId).toBeUndefined();
    await __testing.drain();
    expect(push.user).toHaveBeenCalledWith("lecteur", expect.any(Function));
    const localized = push.user.mock.calls[0][1] as (lang: string) => { title: string; body: string; category: string };
    expect(localized("fr")).toMatchObject({ category: "report-reply", body: "Dune — Dans la bibliothèque" });
    expect(localized("de").title).not.toBe(localized("fr").title);
    expect((await PATCH(req({ status: "maybe" }), params(request.id))).status).toBe(400);
    expect((await PATCH(req({ status: "added" }), params(9999))).status).toBe(404);
  });
});
