import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

/**
 * Les Nouveautés côté serveur (DECISIONS.md §73), sur une vraie base : la page initiale publiée par
 * la migration, le drapeau par compte, la fusion, la relance, les mesures, et l'éditeur de
 * l'administrateur jusqu'à la publication — la traduction par un fournisseur simulé, sans réseau.
 */
const dir = vi.hoisted(() => {
  const d = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "cine-news-"));
  process.env.DATA_DIR = d;
  process.env.SUBTITLE_GEN_API_KEY = "sk-ant-TEST-NEWS-0001";
  return d as string;
});
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getUsers: async () => [{ Id: "1", Name: "louis" }, { Id: "2", Name: "mathis" }, { Id: "3", Name: "emma" }] },
}));

import Database from "better-sqlite3";
import { getDb, seedInitialNews } from "@/lib/db";
import { newsDb, newsFor } from "@/lib/news/store";
import { INITIAL_NEWS_CONTENT, INITIAL_NEWS_SEED, INITIAL_NEWS_VERSION } from "@/lib/news/initialPage";
import { STARTUP_LOG } from "@/lib/eventLogs";
import { setProviderFactoryForTests, type TranslationCall } from "@/lib/subtitleGen/providers";
import { NEWS_TRANSLATION_SCHEMA, rebuild } from "@/lib/news/translate";
import { contentFor, sanitizeContent, type NewsContent } from "@/lib/news/content";
import { median, newsSynthesis } from "@/lib/news/summary";

afterAll(() => {
  setProviderFactoryForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (body?: unknown, headers: Record<string, string> = {}) =>
  ({ cookies: { get: () => ({ value: "t" }) }, json: async () => body, headers: new Headers(headers), signal: undefined }) as unknown as NextRequest;
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const asUser = (u: string) => verify.mockResolvedValue({ u, jfUser: u, role: "user" });
const asAdmin = () => verify.mockResolvedValue({ u: "louis", jfUser: "louis", role: "admin" });

function logLines(): Record<string, unknown>[] {
  if (!fs.existsSync(STARTUP_LOG())) return [];
  return fs
    .readFileSync(STARTUP_LOG(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.kind === "nouveautés");
}

beforeEach(() => verify.mockReset());

describe("la page initiale, publiée par la migration", () => {
  it("base vide : la page 8.44 est publiée, en quatre langues, et le drapeau est allumé pour tous", () => {
    getDb();
    const pages = newsDb.published();
    expect(pages).toHaveLength(1);
    expect(pages[0].version).toBe(INITIAL_NEWS_VERSION);
    expect(pages[0].seq).toBe(1);
    expect(pages[0].content.fr.sections[0].entries[0].title).toBe("Améliorer les dialogues");
    for (const lang of ["en", "es", "de"] as const) expect(pages[0].content[lang]?.sections.length).toBe(2);
    // Aucun compte n'a encore de ligne : chacun, existant ou futur, l'a à voir.
    expect(newsFor("un-compte-quelconque").unseen).toEqual([pages[0].id]);
    expect(newsFor("un-autre").unseen).toEqual([pages[0].id]);
  });

  it("second démarrage : rien ne change — ni nouvelle page, ni republication, ni réarmement", () => {
    const db = getDb();
    const id = newsDb.published()[0].id;
    newsDb.markSeen("vu-avant", [id]);
    expect(newsFor("vu-avant").unseen).toEqual([]);
    seedInitialNews(db);
    seedInitialNews(db);
    expect(newsDb.all()).toHaveLength(1);
    expect(newsFor("vu-avant").unseen).toEqual([]);
  });

  it("une page modifiée ou supprimée par l'administrateur n'est pas réécrite au démarrage suivant", () => {
    const db = new Database(path.join(dir, "seed-only.db"));
    db.exec(`
      CREATE TABLE migrations_done (name TEXT PRIMARY KEY, done_at INTEGER NOT NULL);
      CREATE TABLE news_pages (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', seq INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER);
    `);
    seedInitialNews(db, 1000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM news_pages").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT name FROM migrations_done").all()).toEqual([{ name: INITIAL_NEWS_SEED }]);
    db.prepare("DELETE FROM news_pages").run();
    seedInitialNews(db, 2000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM news_pages").get()).toEqual({ n: 0 });
    db.close();
  });

  it("le contenu initial est celui validé par Louis, et ne parle pas des titres masqués", () => {
    const text = JSON.stringify(INITIAL_NEWS_CONTENT).toLowerCase();
    // « bloquer une fiche » est un bug corrigé, pas un titre masqué : on cherche les titres eux-mêmes.
    expect(text).not.toMatch(/titres? masqu|tags? bloqu|hidden title|blocked tag|títulos? ocult|ausgeblendete titel|gesperrte titel/);
    expect(INITIAL_NEWS_CONTENT.fr.fixes.flatMap((g) => g.items)).toHaveLength(20);
    for (const lang of ["en", "es", "de"] as const) {
      const c = INITIAL_NEWS_CONTENT[lang]!;
      expect(c.fixes.map((g) => g.items.length)).toEqual(INITIAL_NEWS_CONTENT.fr.fixes.map((g) => g.items.length));
      expect(c.sections.map((s) => s.entries.map((e) => e.icon))).toEqual(INITIAL_NEWS_CONTENT.fr.sections.map((s) => s.entries.map((e) => e.icon)));
    }
  });
});

describe("le drapeau par compte", () => {
  it("s'éteint à l'affichage (route `seen`), et seulement pour l'appelant", async () => {
    const { GET } = await import("@/app/api/release-notes/route");
    const seen = await import("@/app/api/release-notes/seen/route");
    asUser("mathis");
    const before = (await (await GET(req())).json()) as { unseen: number[]; pages: { id: number }[] };
    expect(before.unseen).toHaveLength(1);
    expect((await seen.POST(req({ ids: before.unseen }))).status).toBe(204);
    expect(((await (await GET(req())).json()) as { unseen: number[] }).unseen).toEqual([]);
    expect(newsFor("emma").unseen).toHaveLength(1);
  });

  it("refuse un visiteur sans session", async () => {
    verify.mockResolvedValue(null);
    const { GET } = await import("@/app/api/release-notes/route");
    const seen = await import("@/app/api/release-notes/seen/route");
    expect((await GET(req())).status).toBe(401);
    expect((await seen.POST(req({ ids: [1] }))).status).toBe(401);
  });

  it("deux pages de retard : les deux restent à voir, la plus récente d'abord ; un compte neuf ne voit que la dernière", () => {
    newsDb.stateOf("lucas");
    const first = newsDb.published()[0].id;
    newsDb.markSeen("lucas", [first]);
    const a = newsDb.create("8.45", { fr: sanitizeContent({ sections: [{ title: "Nouveau", entries: [{ icon: "tv", title: "A", text: "a" }] }] }) });
    const b = newsDb.create("8.46", { fr: sanitizeContent({ sections: [{ title: "Nouveau", entries: [{ icon: "tv", title: "B", text: "b" }] }] }) });
    // Arrivé quand la 8.44 était la dernière, et l'a vue.
    newsDb.stateOf("en-retard");
    newsDb.markSeen("en-retard", [first]);
    newsDb.publish(a);
    newsDb.publish(b);
    expect(newsFor("en-retard").unseen).toEqual([b, a]);
    // Arrivé après coup : la dernière seulement, pas l'historique fusionné.
    expect(newsFor("tout-neuf").unseen).toEqual([b]);
    // Republier ne change rien.
    expect(newsDb.publish(b)).toBe(newsDb.latestSeq());
    newsDb.markSeen("en-retard", [b, a]);
    expect(newsFor("en-retard").unseen).toEqual([]);
  });

  it("« Relancer » : un compte, puis tous — jamais plus bas que la dernière page", async () => {
    const latest = newsDb.published()[0];
    newsDb.markSeen("emma", [latest.id]);
    newsDb.markSeen("mathis", [latest.id]);
    const relaunch = await import("@/app/api/admin/release-notes/relaunch/route");
    asUser("mathis");
    expect((await relaunch.POST(req({ all: true }))).status).toBe(403);
    asAdmin();
    expect((await relaunch.POST(req({ user: "emma" }))).status).toBe(200);
    expect(newsFor("emma")).toMatchObject({ unseen: [latest.id], relaunched: true });
    expect(newsFor("mathis").unseen).toEqual([]);
    expect((await relaunch.POST(req({ user: "inconnu" }))).status).toBe(404);
    expect((await relaunch.POST(req({ all: true }))).status).toBe(200);
    expect(newsFor("mathis").unseen).toEqual([latest.id]);
    // Une relance n'est plus une relance une fois la fenêtre montrée.
    newsDb.markSeen("mathis", [latest.id], Date.now() + 10);
    expect(newsFor("mathis").relaunched).toBe(false);
  });
});

describe("les mesures", () => {
  it("écrit une ligne `nouveautés` au journal des ouvertures et retient le dernier affichage", async () => {
    const { POST } = await import("@/app/api/release-notes/event/route");
    asUser("emma");
    const ua = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" };
    expect((await POST(req({ event: "fenêtre", noteIds: [1], shownMs: 4321.4, closedBy: "voir-plus", scrolled: true, auto: false, build: "abc", version: "8.44.9" }, ua))).status).toBe(204);
    expect((await POST(req({ event: "voir-plus", noteIds: [1] }, ua))).status).toBe(204);
    expect((await POST(req({ event: "page", shownMs: 12000, section: "corrections" }, ua))).status).toBe(204);
    const lines = logLines().filter((l) => l.user === "emma");
    expect(lines.map((l) => l.event)).toEqual(["fenêtre", "voir-plus", "page"]);
    expect(lines[0]).toMatchObject({ shownMs: 4321, closedBy: "voir-plus", scrolled: true, auto: false, build: "abc", version: "8.44.9", noteIds: [1] });
    expect(lines[2]).toMatchObject({ section: "corrections", shownMs: 12000 });
    const state = newsDb.states().get("emma")!;
    expect(state).toMatchObject({ shownMs: 4321, closedBy: "voir-plus", scrolled: true, auto: false, pageSection: "corrections" });
    expect(state.seeMoreAt).not.toBeNull();
  });

  it("refuse ce qu'il ne connaît pas", async () => {
    const { POST } = await import("@/app/api/release-notes/event/route");
    asUser("emma");
    expect((await POST(req({ event: "autre" }))).status).toBe(400);
    expect((await POST(req({ event: "fenêtre", shownMs: 10, closedBy: "n'importe" }))).status).toBe(400);
    expect((await POST(req({ event: "page", shownMs: -3, section: "corrections" }))).status).toBe(400);
  });

  it("synthèse : médiane, part « pas lue » (< 2 s) et part « Voir plus »", () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1000, 3000])).toBe(2000);
    expect(median([])).toBeNull();
    const latest = { id: 9, version: "9.0", seq: 9, status: "published", content: { fr: sanitizeContent({}) }, createdAt: 0, updatedAt: 0, publishedAt: 0 } as const;
    const state = (user: string, shownMs: number, seeMore: boolean) => ({
      user, seenSeq: 9, createdAt: 0, shownAt: 1, shownIds: [9], shownMs, closedBy: "ok", scrolled: false, auto: true,
      seeMoreAt: seeMore ? 1 : null, pageAt: null, pageMs: null, pageSection: null, rearmedAt: null,
    });
    const s = newsSynthesis(["a", "b", "c", "d"], new Map([["a", state("a", 800, false)], ["b", state("b", 5000, true)], ["c", state("c", 9000, false)]]), [{ ...latest }]);
    expect(s).toMatchObject({ seen: 3, accounts: 4, medianShownMs: 5000, notReadShare: 1 / 3, seeMoreShare: 1 / 3 });
  });
});

describe("l'éditeur de l'administrateur", () => {
  const fr: NewsContent = sanitizeContent({
    sections: [{ title: "Nouveau", entries: [{ icon: "cast", title: "Diffusion", text: "Sur la télé.", badge: "bêta" }] }],
    fixesSummary: "Plus rapide.",
    fixes: [{ title: "Lecture", items: ["Un correctif.", "Un autre."] }],
  });
  const translated = (tag: string) => ({
    sections: [{ title: `${tag} New`, entries: [{ title: `${tag} Cast`, text: `${tag} On TV.`, badge: "beta" }] }],
    fixesSummary: `${tag} Faster.`,
    fixes: [{ title: `${tag} Playback`, items: [`${tag} One.`, `${tag} Two.`] }],
  });

  it("réserve tout à l'administrateur, lecture comprise", async () => {
    const admin = await import("@/app/api/admin/release-notes/route");
    const translate = await import("@/app/api/admin/release-notes/translate/route");
    asUser("mathis");
    expect((await admin.GET(req())).status).toBe(403);
    expect((await admin.POST(req({ version: "9", content: { fr } }))).status).toBe(403);
    expect((await translate.POST(req({ fr }))).status).toBe(403);
  });

  it("crée un brouillon en français, le traduit (un appel, sortie structurée), le publie : le drapeau se rallume pour tous", async () => {
    const calls: TranslationCall[] = [];
    setProviderFactoryForTests(() => ({
      name: "anthropic",
      model: "claude-haiku-5-5",
      async complete(call) {
        calls.push(call);
        const json = { en: translated("EN"), es: translated("ES"), de: translated("DE") };
        return { json, text: JSON.stringify(json), usage: { inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 } };
      },
    }));
    asAdmin();
    const admin = await import("@/app/api/admin/release-notes/route");
    const page = await import("@/app/api/admin/release-notes/[id]/route");
    const publish = await import("@/app/api/admin/release-notes/[id]/publish/route");
    const translate = await import("@/app/api/admin/release-notes/translate/route");

    const created = await admin.POST(req({ version: "9.0", content: { fr } }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    expect(newsDb.get(id)?.status).toBe("draft");
    // Un brouillon ne s'annonce à personne.
    newsDb.markSeen("emma", newsDb.published().map((p) => p.id));
    expect(newsFor("emma").unseen).toEqual([]);

    const tr = await translate.POST(req({ fr }));
    expect(tr.status).toBe(200);
    const out = (await tr.json()) as Record<"en" | "es" | "de", NewsContent>;
    expect(calls).toHaveLength(1);
    expect(calls[0].schema).toEqual(NEWS_TRANSLATION_SCHEMA);
    expect(calls[0].user).not.toContain("cast"); // les icônes ne passent pas par le modèle
    expect(out.de.sections[0].entries[0]).toEqual({ icon: "cast", title: "DE Cast", text: "DE On TV.", badge: "beta" });

    // L'espagnol laissé vide retombe sur le français.
    expect((await page.PUT(req({ version: "9.0", content: { fr, en: out.en, es: null, de: out.de } }), params(id))).status).toBe(200);
    const saved = newsDb.get(id)!;
    expect(saved.content.es).toBeNull();
    expect(contentFor(saved.content, "es")).toEqual(fr);
    expect(contentFor(saved.content, "de").fixesSummary).toBe("DE Faster.");

    expect((await publish.POST(req(), params(id))).status).toBe(200);
    expect(newsFor("emma").unseen).toEqual([id]);
    expect(newsFor("mathis").unseen[0]).toBe(id);

    const listed = (await (await admin.GET(req())).json()) as { pages: { id: number }[]; accounts: { name: string }[]; translateAvailable: boolean };
    expect(listed.pages[0].id).toBe(id);
    expect(listed.accounts.map((a) => a.name)).toEqual(expect.arrayContaining(["louis", "mathis", "emma"]));
    expect(listed.translateAvailable).toBe(true);
  });

  it("refuse une traduction qui ne garde pas la forme du français", async () => {
    expect(rebuild(fr, { ...translated("X"), fixes: [{ title: "x", items: ["un seul"] }] })).toBeNull();
    setProviderFactoryForTests(() => ({
      name: "anthropic",
      model: "m",
      async complete() {
        const json = { en: translated("EN"), es: { ...translated("ES"), sections: [] }, de: translated("DE") };
        return { json, text: "", usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 } };
      },
    }));
    asAdmin();
    const translate = await import("@/app/api/admin/release-notes/translate/route");
    expect((await translate.POST(req({ fr }))).status).toBe(502);
  });

  it("refuse une page sans version ou sans français", async () => {
    asAdmin();
    const admin = await import("@/app/api/admin/release-notes/route");
    expect((await admin.POST(req({ version: "", content: { fr } }))).status).toBe(400);
    expect((await admin.POST(req({ version: "9.1", content: { en: fr } }))).status).toBe(400);
  });
});
