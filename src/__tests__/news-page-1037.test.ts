import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { NEWS_LANGS, sanitizeContent } from "@/lib/news/content";
import { NEWS_1037_CONTENT, NEWS_1037_SEED, NEWS_1037_VERSION } from "@/lib/news/page1037";
import { seedQuietNewsPage } from "@/lib/db";

/** La page « 10.37 » (11/11/2026) : l'historique rempli sans fenêtre, seulement ce que tout compte a. */
describe("la page Nouveautés 10.37", () => {
  it("passe telle quelle dans les bornes de l'éditeur, de même forme dans les quatre langues", () => {
    const shape = (lang: (typeof NEWS_LANGS)[number]) => NEWS_1037_CONTENT[lang]!.sections.map((s) => s.entries.map((e) => e.icon));
    for (const lang of NEWS_LANGS) {
      expect(NEWS_1037_CONTENT[lang], lang).toBeTruthy();
      expect(sanitizeContent(NEWS_1037_CONTENT[lang]), lang).toEqual(NEWS_1037_CONTENT[lang]);
      expect(shape(lang), lang).toEqual(shape("fr"));
    }
  });

  it("vouvoie, ne dit rien de la fabrication, ni des fonctions encore réservées ou cachées", () => {
    for (const lang of NEWS_LANGS) {
      const text = JSON.stringify(NEWS_1037_CONTENT[lang]);
      expect(text, lang).not.toMatch(/masqu|dashboard|tableau de bord|\bstack\b|cache|Jellyfin|\bIA\b|\bAI\b|\bKI\b/i);
      // « À l'écran », les questions, « Jusqu'ici » : annoncés par Louis à leur ouverture ; le chalet est un secret.
      expect(text, lang).not.toMatch(/Jusqu|So far|Hasta ahora|Bis jetzt|écran »|On screen|question|Chalet|Immersion/i);
    }
    expect(JSON.stringify(NEWS_1037_CONTENT.fr)).not.toMatch(/\b(tu|ton|ta|tes|toi)\b|-toi\b/);
    expect(JSON.stringify(NEWS_1037_CONTENT.de)).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
  });

  it("est publiée sans fenêtre, une seule fois, au-dessus d'un brouillon", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE migrations_done (name TEXT PRIMARY KEY, done_at INTEGER NOT NULL);
      CREATE TABLE news_pages (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL, seq INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER);
      CREATE TABLE news_state (user_name TEXT PRIMARY KEY, seen_seq INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO news_pages (version, content, status, seq, created_at, updated_at) VALUES ('10.13', '{}', 'published', 13, 1, 1);
      INSERT INTO news_pages (version, content, status, seq, created_at, updated_at) VALUES ('10.33', '{}', 'draft', NULL, 1, 1);
      INSERT INTO news_state VALUES ('a-jour', 13, 1), ('en-retard', 9, 1);
    `);
    seedQuietNewsPage(db, NEWS_1037_SEED, NEWS_1037_VERSION, NEWS_1037_CONTENT, 2);
    seedQuietNewsPage(db, NEWS_1037_SEED, NEWS_1037_VERSION, NEWS_1037_CONTENT, 3);
    expect(db.prepare("SELECT version, status, seq FROM news_pages ORDER BY id").all()).toEqual([
      { version: "10.13", status: "published", seq: 13 },
      { version: "10.33", status: "draft", seq: null },
      { version: "10.37", status: "published", seq: 14 },
    ]);
    // À jour : rien à voir, donc pas de fenêtre ; en retard : il garde son retard, la page s'y empile.
    expect(db.prepare("SELECT user_name, seen_seq FROM news_state ORDER BY user_name").all()).toEqual([
      { user_name: "a-jour", seen_seq: 14 },
      { user_name: "en-retard", seen_seq: 9 },
    ]);
  });
});
