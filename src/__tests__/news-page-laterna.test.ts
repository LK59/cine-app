import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { NEWS_LANGS, sanitizeContent } from "@/lib/news/content";
import { NEWS_LATERNA_CONTENT, NEWS_LATERNA_SEED, NEWS_LATERNA_VERSION } from "@/lib/news/pageLaterna";

/**
 * La page du renommage (§118), préparée mais pas branchée : elle doit pouvoir être publiée par une
 * seule ligne dans `db.ts`, telle quelle — donc déjà dans les bornes de l'éditeur, dans les quatre
 * langues, de même forme partout.
 */
describe("la page Nouveautés de Laterna", () => {
  it("passe telle quelle dans les bornes de l'éditeur, dans les quatre langues", () => {
    for (const lang of NEWS_LANGS) {
      const content = NEWS_LATERNA_CONTENT[lang]!;
      expect(content, lang).toBeTruthy();
      expect(sanitizeContent(content), lang).toEqual(content);
    }
  });

  it("a la même forme dans chaque langue : sections, entrées, icônes", () => {
    const shape = (lang: (typeof NEWS_LANGS)[number]) =>
      NEWS_LATERNA_CONTENT[lang]!.sections.map((s) => s.entries.map((e) => e.icon));
    for (const lang of NEWS_LANGS) expect(shape(lang), lang).toEqual(shape("fr"));
  });

  it("dit le nom, le moteur et la nouvelle adresse — sans vocabulaire d'infrastructure, vouvoiement, ni brique ni client", () => {
    for (const lang of NEWS_LANGS) {
      const text = JSON.stringify(NEWS_LATERNA_CONTENT[lang]);
      expect(text, lang).toContain("Laterna");
      expect(text, lang).toContain("Lumen");
      expect(text, lang).toContain("app.laterna.fr");
      expect(text, lang).not.toMatch(/masqu|dashboard|tableau de bord|\bstack\b|domaine|domain|cache|PWA|OPFS|cookie/i);
    }
    // Vouvoiement partout : « vous », « usted », « Sie ».
    expect(JSON.stringify(NEWS_LATERNA_CONTENT.fr)).not.toMatch(/\b(tu|ton|ta|tes|toi)\b|-toi\b/);
    expect(JSON.stringify(NEWS_LATERNA_CONTENT.es)).not.toMatch(/\b(tú|tu|tus|te)\b/);
    expect(JSON.stringify(NEWS_LATERNA_CONTENT.de)).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
    // Ni brique du moteur ni client Jellyfin sur cette page.
    for (const lang of NEWS_LANGS) {
      expect(JSON.stringify(NEWS_LATERNA_CONTENT[lang])).not.toMatch(/PlaybackCore|MuxCore|AudioCore|BufferCore|StreamCore|CodecBridge|PlaybackBridge|Lumen by Laterna/);
    }
  });

  it("n'est pas encore semée : rien ne la publie avant le signal", () => {
    expect(NEWS_LATERNA_VERSION).toBe("9.4");
    expect(NEWS_LATERNA_SEED).toBe("news-seed-laterna");
    expect(readFileSync("src/lib/db.ts", "utf8")).not.toContain("pageLaterna");
  });
});
