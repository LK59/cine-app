import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";

/**
 * La page « 9.0 » (téléchargements hors ligne) : semée en brouillon le 19/10/2026, publiée pour toutes
 * les installations et tous les comptes le 20/10 (`publishNewsDraft`) — une fois, sans doublon.
 */
const dir = vi.hoisted(() => {
  const d = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "cine-news-90-"));
  process.env.DATA_DIR = d;
  return d as string;
});
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: dir }));

import { getDb, publishNewsDraft } from "@/lib/db";
import { newsDb, newsFor } from "@/lib/news/store";
import { NEWS_90_CONTENT, NEWS_90_PUBLISH, NEWS_90_VERSION } from "@/lib/news/page90";
import { NEWS_105_VERSION } from "@/lib/news/page105";
import { NEWS_1037_VERSION } from "@/lib/news/page1037";
import { NEWS_1040_VERSION } from "@/lib/news/page1040";

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("publication de la page 9.0", () => {
  it("publiée au démarrage, une seule fois, et la plus récente : chaque compte l'a à voir", () => {
    getDb();
    const pages = newsDb.all().filter((p) => p.version === NEWS_90_VERSION);
    expect(pages).toHaveLength(1);
    expect(pages[0].status).toBe("published");
    // La plus récente de son temps : seules les pages discrètes, publiées après elle sans fenêtre (10.5 le
    // 27/10/2026, 10.37 le 11/11/2026, 10.40 le 13/11/2026), la dépassent.
    const quiet = [NEWS_105_VERSION, NEWS_1037_VERSION, NEWS_1040_VERSION];
    expect(pages[0].seq).toBe(Math.max(...newsDb.published().filter((p) => !quiet.includes(p.version)).map((p) => p.seq!)));
    // Un compte neuf n'en voit que trois (FIRST_VIEW_PAGES) : depuis la 10.40 (13/11/2026), ce sont les trois discrètes,
    // et la 9.0 reste dans Compte → Nouveautés. Un redémarrage ne la republie pas : vue une fois, elle ne revient pas.
    newsDb.markSeen("quelquun", newsDb.published().map((p) => p.id));
    publishNewsDraft(getDb(), NEWS_90_PUBLISH, NEWS_90_VERSION, NEWS_90_CONTENT);
    expect(newsFor("quelquun").unseen).not.toContain(pages[0].id);
    expect(newsDb.all().filter((p) => p.version === NEWS_90_VERSION)).toHaveLength(1);
  });
});
