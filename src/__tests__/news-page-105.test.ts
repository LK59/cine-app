import { describe, it, expect, beforeEach } from "vitest";
import { getDb, seedQuietNewsPage, applyFixesLedger } from "@/lib/db";
import { NEWS_105_CONTENT, NEWS_105_SEED, NEWS_105_VERSION } from "@/lib/news/page105";
import { FIXES_LEDGER, compareVersions } from "@/lib/news/fixesLedger";
import { NEWS_LANGS, NEWS_LIMITS } from "@/lib/news/content";
import { newsFor } from "@/lib/news/store";

/**
 * La page « 10.5 », publiée sans fenêtre (27/10/2026, DECISIONS.md §73) : consultable dans Compte →
 * Nouveautés par tous, mais aucun compte à jour ne se la voit présenter au lancement.
 */

const SEED = "test-page-discrete";
const empty = { fr: { sections: [], fixesSummary: "", fixes: [] } };

function page(version: string, seq: number | null, status = "published") {
  getDb()
    .prepare("INSERT INTO news_pages (version, content, status, seq, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, 1, 1, 1)")
    .run(version, JSON.stringify(empty), status, seq);
}
const account = (user: string, seen: number) =>
  getDb().prepare("INSERT INTO news_state (user_name, seen_seq, created_at) VALUES (?, ?, 1)").run(user, seen);
const seenOf = (user: string) => (getDb().prepare("SELECT seen_seq FROM news_state WHERE user_name = ?").get(user) as { seen_seq: number }).seen_seq;

beforeEach(() => {
  getDb().prepare("DELETE FROM news_pages").run();
  getDb().prepare("DELETE FROM news_state").run();
  getDb().prepare("DELETE FROM migrations_done WHERE name = ?").run(SEED);
});

describe("une page publiée sans fenêtre", () => {
  it("s'ajoute en tête des pages, sans rien à voir pour un compte à jour", () => {
    page("9.0", 4);
    page("10.0", 5);
    account("a-jour", 5);
    seedQuietNewsPage(getDb(), SEED, "10.5", empty);
    expect(seenOf("a-jour")).toBe(6);
    const news = newsFor("a-jour");
    expect(news.pages[0].version).toBe("10.5");
    expect(news.unseen).toEqual([]);
  });

  it("un compte en retard garde son retard : la page s'empile avec les autres", () => {
    page("9.0", 4);
    page("10.0", 5);
    account("en-retard", 4);
    seedQuietNewsPage(getDb(), SEED, "10.5", empty);
    expect(seenOf("en-retard")).toBe(4);
    expect(newsFor("en-retard").unseen).toHaveLength(2);
  });

  it("à jour, c'est avoir vu la dernière page publiée — une page dépubliée garde son rang sans compter", () => {
    page("9.0", 4);
    page("9.9", 5, "draft");
    account("a-jour", 4);
    seedQuietNewsPage(getDb(), SEED, "10.5", empty);
    expect(seenOf("a-jour")).toBe(6);
  });

  it("une seule fois : un redémarrage ne la recrée pas et ne touche à personne", () => {
    page("10.0", 5);
    account("a-jour", 5);
    seedQuietNewsPage(getDb(), SEED, "10.5", empty);
    getDb().prepare("UPDATE news_state SET seen_seq = 5").run();
    seedQuietNewsPage(getDb(), SEED, "10.5", empty);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM news_pages WHERE version = '10.5'").get() as { n: number }).n).toBe(1);
    expect(seenOf("a-jour")).toBe(5);
  });
});

describe("la page 10.5", () => {
  it("reprend au mot près les corrections du registre depuis la 10.1, dans les quatre langues", () => {
    const since = FIXES_LEDGER.filter((e) => compareVersions(e.version, "10.1") >= 0);
    expect(since.length).toBeGreaterThan(0);
    for (const lang of NEWS_LANGS) {
      const items = NEWS_105_CONTENT[lang]!.fixes.flatMap((g) => g.items);
      for (const e of since) for (const i of e.items) expect(items).toContain(i[lang]);
    }
  });

  it("le registre versé ensuite ne double rien", () => {
    getDb().prepare("DELETE FROM migrations_done WHERE name = ? OR name LIKE 'news-fix:%'").run(NEWS_105_SEED);
    seedQuietNewsPage(getDb(), NEWS_105_SEED, NEWS_105_VERSION, NEWS_105_CONTENT);
    applyFixesLedger(getDb(), FIXES_LEDGER.filter((e) => compareVersions(e.version, "10.1") >= 0));
    const content = JSON.parse((getDb().prepare("SELECT content FROM news_pages WHERE version = '10.5'").get() as { content: string }).content);
    expect(content).toEqual(JSON.parse(JSON.stringify(NEWS_105_CONTENT)));
  });

  it("tient dans les bornes d'une page", () => {
    for (const lang of NEWS_LANGS) {
      const c = NEWS_105_CONTENT[lang]!;
      expect(c.sections.length).toBeLessThanOrEqual(NEWS_LIMITS.sections);
      for (const s of c.sections) {
        expect(s.entries.length).toBeLessThanOrEqual(NEWS_LIMITS.entries);
        for (const e of s.entries) {
          expect(e.title.length).toBeLessThanOrEqual(NEWS_LIMITS.entryTitle);
          expect(e.text.length).toBeLessThanOrEqual(NEWS_LIMITS.entryText);
        }
      }
      expect(c.fixesSummary.length).toBeLessThanOrEqual(NEWS_LIMITS.fixesSummary);
      expect(c.fixes.length).toBeLessThanOrEqual(NEWS_LIMITS.fixGroups);
      for (const g of c.fixes) for (const i of g.items) expect(i.length).toBeLessThanOrEqual(NEWS_LIMITS.fixItem);
    }
  });
});
