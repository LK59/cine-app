import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { NEWS_LANGS, sanitizeContent } from "@/lib/news/content";
import { NEWS_1025_CONTENT, NEWS_1025_SEED, NEWS_1025_VERSION } from "@/lib/news/page1025";
import { seedNewsPage } from "@/lib/db";

/** La page « 10.25 » (« Poser une question », 09/11/2026) : en brouillon, que Louis publie après relecture. */
describe("la page Nouveautés 10.25", () => {
  it("passe telle quelle dans les bornes de l'éditeur, de même forme dans les quatre langues", () => {
    const shape = (lang: (typeof NEWS_LANGS)[number]) => NEWS_1025_CONTENT[lang]!.sections.map((s) => s.entries.map((e) => e.icon));
    for (const lang of NEWS_LANGS) {
      expect(NEWS_1025_CONTENT[lang], lang).toBeTruthy();
      expect(sanitizeContent(NEWS_1025_CONTENT[lang]), lang).toEqual(NEWS_1025_CONTENT[lang]);
      expect(shape(lang), lang).toEqual(shape("fr"));
      for (const entry of NEWS_1025_CONTENT[lang]!.sections.flatMap((s) => s.entries)) {
        expect(entry.text.charAt(0), `${lang} ${entry.title}`).toMatch(/[A-ZÀ-Ý¿]/);
      }
    }
  });

  it("vouvoie, et ne dit rien de la fabrication", () => {
    for (const lang of NEWS_LANGS) {
      expect(JSON.stringify(NEWS_1025_CONTENT[lang]), lang).not.toMatch(/masqu|dashboard|tableau de bord|\bstack\b|cache|PWA|React|Jellyfin|i\/s|fps/i);
    }
    expect(JSON.stringify(NEWS_1025_CONTENT)).not.toMatch(/\b(IA|AI|KI)\b|intelligence artificielle|artificial intelligence/i);
    expect(JSON.stringify(NEWS_1025_CONTENT.fr)).not.toMatch(/\b(tu|ton|ta|tes|toi)\b|-toi\b|\(s\)/);
    expect(JSON.stringify(NEWS_1025_CONTENT.es)).not.toMatch(/\b(tú|tu|tus|te)\b/);
    expect(JSON.stringify(NEWS_1025_CONTENT.de)).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
  });

  it("est semée en brouillon, une seule fois", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE migrations_done (name TEXT PRIMARY KEY, done_at INTEGER NOT NULL);
      CREATE TABLE news_pages (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL, seq INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER);
    `);
    seedNewsPage(db, NEWS_1025_SEED, NEWS_1025_VERSION, NEWS_1025_CONTENT, 1, "draft");
    seedNewsPage(db, NEWS_1025_SEED, NEWS_1025_VERSION, NEWS_1025_CONTENT, 2, "draft");
    expect(db.prepare("SELECT version, status, seq FROM news_pages").all()).toEqual([{ version: "10.25", status: "draft", seq: null }]);
  });
});
