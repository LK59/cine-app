import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";

/**
 * La page 8.67.2 complétée puis republiée (Louis, 19/10/2026) : sur une installation qui l'avait
 * déjà, vue par un compte, elle prend la version 8.68, son nouveau contenu et un nouveau rang —
 * chacun la revoit, une seule fois. Une base à part : la republication change l'ordre des pages
 * dont dépendent les tests de `news-store-routes`.
 */
const dir = vi.hoisted(() => {
  const d = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "cine-news-rep-"));
  process.env.DATA_DIR = d;
  return d as string;
});
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: dir }));

import { getDb, republishNewsPage } from "@/lib/db";
import { newsDb, newsFor } from "@/lib/news/store";
import { NEWS_8672_CONTENT, NEWS_8672_FIRST_VERSION, NEWS_8672_REPUBLISH, NEWS_8672_VERSION } from "@/lib/news/page8672";

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("republication de la page 8.67.2", () => {
  it("la 8.67.2 déjà vue est complétée et republiée une fois : chacun la revoit, en 8.68", () => {
    const db = getDb();
    // Une installation qui avait la page d'hier, vue par un compte.
    const page = newsDb.published().find((p) => p.version === NEWS_8672_VERSION)!;
    db.prepare("UPDATE news_pages SET version = ?, content = ? WHERE id = ?").run(NEWS_8672_FIRST_VERSION, "{}", page.id);
    db.prepare("DELETE FROM migrations_done WHERE name = ?").run(NEWS_8672_REPUBLISH);
    newsDb.markSeen("vu-hier", newsDb.published().map((p) => p.id));
    expect(newsFor("vu-hier").unseen).toEqual([]);
    const before = newsDb.all().length;
    republishNewsPage(db, NEWS_8672_REPUBLISH, NEWS_8672_FIRST_VERSION, NEWS_8672_VERSION, NEWS_8672_CONTENT);
    expect(newsFor("vu-hier").unseen).toEqual([page.id]);
    const again = newsDb.all().find((p) => p.id === page.id)!;
    expect(again.version).toBe(NEWS_8672_VERSION);
    expect(again.content.fr.sections[0].entries).toHaveLength(2);
    expect(again.seq).toBe(Math.max(...newsDb.published().map((p) => p.seq!)));
    expect(newsDb.all()).toHaveLength(before);
    // Une seule fois : un redémarrage ne la réarme pas.
    newsDb.markSeen("vu-hier", [page.id]);
    republishNewsPage(db, NEWS_8672_REPUBLISH, NEWS_8672_FIRST_VERSION, NEWS_8672_VERSION, NEWS_8672_CONTENT);
    expect(newsFor("vu-hier").unseen).toEqual([]);
  });

});
