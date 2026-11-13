import { describe, it, expect } from "vitest";
import { NEWS_LANGS, sanitizeContent } from "@/lib/news/content";
import { NEWS_1043_CONTENT } from "@/lib/news/page1043";

/** La page « 10.43 » (13/11/2026) : la fenêtre « Détails » des fiches de films, sans fenêtre de Nouveautés (§152). */
describe("la page Nouveautés 10.43", () => {
  it("passe telle quelle dans les bornes de l'éditeur, de même forme dans les quatre langues", () => {
    const shape = (lang: (typeof NEWS_LANGS)[number]) => NEWS_1043_CONTENT[lang]!.sections.map((s) => s.entries.map((e) => e.icon));
    for (const lang of NEWS_LANGS) {
      expect(NEWS_1043_CONTENT[lang], lang).toBeTruthy();
      expect(sanitizeContent(NEWS_1043_CONTENT[lang]), lang).toEqual(NEWS_1043_CONTENT[lang]);
      expect(shape(lang), lang).toEqual(shape("fr"));
    }
  });

  it("vouvoie, ne dit rien de la fabrication, et ne promet rien du son", () => {
    for (const lang of NEWS_LANGS) {
      const text = JSON.stringify(NEWS_1043_CONTENT[lang]);
      expect(text, lang).not.toMatch(/dashboard|tableau de bord|\bstack\b|Jellyfin|\bIA\b|\bAI\b|\bKI\b|bêta|beta|Lab\b/i);
      expect(text, lang).not.toMatch(/atmos/i);
    }
    expect(JSON.stringify(NEWS_1043_CONTENT.fr)).not.toMatch(/\b(tu|ton|ta|tes|toi)\b|-toi\b/);
    expect(JSON.stringify(NEWS_1043_CONTENT.de)).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
    expect(JSON.stringify(NEWS_1043_CONTENT.fr)).toContain("Détails");
  });
});
