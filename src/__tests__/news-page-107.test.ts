import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { NEWS_LANGS, sanitizeContent } from "@/lib/news/content";
import { booksNewsPage, NEWS_107_CONTENT, NEWS_107_SEED, NEWS_107_VERSION } from "@/lib/news/page107";
import { seedNewsPage } from "@/lib/db";

/**
 * La page « 10.7 » (les livres, §127, et la 10.6) : seulement sur l'installation qui annonce sa
 * nouvelle adresse — les livres sont une option coupée par défaut —, et en brouillon, que Louis publie
 * le soir où il allume l'option.
 */
describe("la page Nouveautés 10.7", () => {
  it("passe telle quelle dans les bornes de l'éditeur, de même forme dans les quatre langues", () => {
    const shape = (lang: (typeof NEWS_LANGS)[number]) => NEWS_107_CONTENT[lang]!.sections.map((s) => s.entries.map((e) => e.icon));
    for (const lang of NEWS_LANGS) {
      expect(NEWS_107_CONTENT[lang], lang).toBeTruthy();
      expect(sanitizeContent(NEWS_107_CONTENT[lang]), lang).toEqual(NEWS_107_CONTENT[lang]);
      expect(shape(lang), lang).toEqual(shape("fr"));
      for (const entry of NEWS_107_CONTENT[lang]!.sections.flatMap((s) => s.entries)) {
        // Une phrase qui commence par une majuscule passe sous le titre : rien n'est coupé en deux.
        expect(entry.text.charAt(0), `${lang} ${entry.title}`).toMatch(/[A-ZÀ-Ý¿]/);
      }
    }
  });

  it("vouvoie, et ne dit rien de la fabrication", () => {
    for (const lang of NEWS_LANGS) {
      expect(JSON.stringify(NEWS_107_CONTENT[lang]), lang).not.toMatch(/masqu|dashboard|tableau de bord|\bstack\b|cache|PWA|OPFS|EPUB|Jellyfin|index/i);
    }
    expect(JSON.stringify(NEWS_107_CONTENT.fr)).not.toMatch(/\b(tu|ton|ta|tes|toi)\b|-toi\b/);
    expect(JSON.stringify(NEWS_107_CONTENT.es)).not.toMatch(/\b(tú|tu|tus|te)\b/);
    expect(JSON.stringify(NEWS_107_CONTENT.de)).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
  });

  it("n'existe que sur l'installation qui annonce sa nouvelle adresse", () => {
    for (const none of [undefined, null, "", "cine-app"]) expect(booksNewsPage(none), String(none)).toBeNull();
    expect(booksNewsPage("app.example.org")).toEqual({ seed: NEWS_107_SEED, version: NEWS_107_VERSION, content: NEWS_107_CONTENT });
  });

  it("est semée en brouillon, une seule fois", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE migrations_done (name TEXT PRIMARY KEY, done_at INTEGER NOT NULL);
      CREATE TABLE news_pages (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL, seq INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER);
    `);
    const page = booksNewsPage("app.example.org")!;
    seedNewsPage(db, page.seed, page.version, page.content, 1, "draft");
    seedNewsPage(db, page.seed, page.version, page.content, 2, "draft");
    const rows = db.prepare("SELECT version, status, seq FROM news_pages").all();
    expect(rows).toEqual([{ version: "10.7", status: "draft", seq: null }]);
  });
});
