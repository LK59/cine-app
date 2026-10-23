import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { NEWS_LANGS, sanitizeContent } from "@/lib/news/content";
import { laternaAddress, laternaNewsContent, laternaNewsPage, NEWS_LATERNA_SEED, NEWS_LATERNA_VERSION } from "@/lib/news/pageLaterna";

/**
 * La page du renommage (§118), préparée mais pas branchée : elle doit pouvoir être publiée par deux
 * lignes dans `db.ts`, telle quelle — dans les bornes de l'éditeur, dans les quatre langues, de même
 * forme partout —, et seulement sur l'installation dont le déploiement donne la nouvelle adresse.
 */
const ADDRESS = "app.example.org";
const content = laternaNewsContent(ADDRESS);

afterEach(() => vi.unstubAllEnvs());

describe("la page Nouveautés de Laterna", () => {
  it("passe telle quelle dans les bornes de l'éditeur, dans les quatre langues", () => {
    for (const lang of NEWS_LANGS) {
      expect(content[lang], lang).toBeTruthy();
      expect(sanitizeContent(content[lang]), lang).toEqual(content[lang]);
    }
  });

  it("quatre cartes de même forme dans chaque langue, des titres qui tiennent seuls", () => {
    const shape = (lang: (typeof NEWS_LANGS)[number]) => content[lang]!.sections.map((s) => s.entries.map((e) => e.icon));
    for (const lang of NEWS_LANGS) {
      expect(shape(lang), lang).toEqual([["sparkles", "phone", "wrench", "heart"]]);
      for (const entry of content[lang]!.sections.flatMap((s) => s.entries)) {
        // Une phrase qui commence par une majuscule passe sous le titre : rien n'est coupé en deux.
        expect(entry.text.charAt(0), `${lang} ${entry.title}`).toMatch(/[A-ZÀ-Ý]/);
        expect(entry.title, lang).not.toMatch(/[,:]$/);
      }
    }
    expect(content.fr.sections[0].entries.map((e) => [e.title, e.text]).slice(2)).toEqual([
      ["À refaire sur l'appareil", "Vos téléchargements et les notifications."],
      ["Ce qui vous suit", "Votre historique, vos reprises, vos listes et vos films vus."],
    ]);
  });

  it("dit le nom, le moteur et l'adresse du réglage — vouvoiement, ni réglage d'appareil, ni brique, ni client", () => {
    for (const lang of NEWS_LANGS) {
      const text = JSON.stringify(content[lang]);
      expect(text, lang).toContain("Laterna");
      expect(text, lang).toContain("Lumen");
      expect(text, lang).toContain(ADDRESS);
      expect(text, lang).not.toMatch(/masqu|dashboard|tableau de bord|\bstack\b|domaine|domain|cache|PWA|OPFS|cookie/i);
      expect(text, lang).not.toMatch(/volume|Lautstärke|sous-titres|subtitle|subtítulos|Untertitel/i);
      expect(text, lang).not.toMatch(/PlaybackCore|MuxCore|AudioCore|BufferCore|StreamCore|CodecBridge|PlaybackBridge|Lumen by Laterna/);
    }
    expect(JSON.stringify(content.fr)).not.toMatch(/\b(tu|ton|ta|tes|toi)\b|-toi\b/);
    expect(JSON.stringify(content.es)).not.toMatch(/\b(tú|tu|tus|te)\b/);
    expect(JSON.stringify(content.de)).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
  });

  it("l'adresse vient du réglage, jamais du code de la page", () => {
    expect(readFileSync("src/lib/news/pageLaterna.ts", "utf8")).not.toMatch(/laterna\.fr/i);
    expect(laternaAddress("app.example.org")).toBe("app.example.org");
    expect(laternaAddress(" https://app.example.org/ ")).toBe("app.example.org");
    for (const bad of ["", "   ", null, undefined, "cine-app", "ftp://app.example.org", "https://app.example.org/chemin", "https://u:p@app.example.org", "pas une adresse"]) {
      expect(laternaAddress(bad), String(bad)).toBeNull();
    }
  });

  it("sans adresse, rien à semer — le cas de toute autre installation", () => {
    expect(laternaNewsPage("")).toBeNull();
    expect(laternaNewsPage(undefined)).toBeNull();
    expect(laternaNewsPage(ADDRESS)).toEqual({ seed: NEWS_LATERNA_SEED, version: NEWS_LATERNA_VERSION, content });
  });

  it("le réglage de déploiement NEWS_LATERNA_ADDRESS est lu par config.ts, l'environnement seul", async () => {
    vi.stubEnv("NEWS_LATERNA_ADDRESS", "app.example.org");
    const { config } = await import("@/lib/config");
    expect(config.news.laternaAddress).toBe("app.example.org");
    vi.stubEnv("NEWS_LATERNA_ADDRESS", "");
    expect(laternaNewsPage(config.news.laternaAddress)).toBeNull();
  });

  it("une fois branchée, elle se publie une fois, et seulement avec l'adresse", async () => {
    const { seedNewsPage } = await import("@/lib/db");
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE news_pages (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT, content TEXT, status TEXT, seq INTEGER, created_at INTEGER, updated_at INTEGER, published_at INTEGER);
             CREATE TABLE migrations_done (name TEXT PRIMARY KEY, done_at INTEGER);`);
    // Ce que fera la ligne de `db.ts` : rien sans adresse…
    for (const raw of ["", ADDRESS, ADDRESS]) {
      const page = laternaNewsPage(raw);
      if (page) seedNewsPage(db, page.seed, page.version, page.content);
    }
    const rows = db.prepare("SELECT version, status, content FROM news_pages").all() as { version: string; status: string; content: string }[];
    // … et une seule page avec, même au second démarrage.
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(NEWS_LATERNA_VERSION);
    expect(rows[0].status).toBe("published");
    expect(rows[0].content).toContain(ADDRESS);
    db.close();
  });

  it("semée en brouillon seulement, et seulement avec l'adresse (Louis la publie lui-même)", () => {
    expect(NEWS_LATERNA_SEED).toBe("news-seed-laterna");
    const src = readFileSync("src/lib/db.ts", "utf8");
    expect(src).toMatch(/const laterna = laternaNewsPage\(config\.news\?\.laternaAddress\);\s*if \(laterna\) seedNewsPage\(db, laterna\.seed, laterna\.version, laterna\.content, Date\.now\(\), "draft"\);/);
  });
});
