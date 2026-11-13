import { describe, it, expect } from "vitest";
import { NEWS_LANGS, sanitizeContent } from "@/lib/news/content";
import { NEWS_1040_CONTENT } from "@/lib/news/page1040";

/** La page « 10.40 » (13/11/2026) : les sous-titres d'un passage rejoué, sans fenêtre (§150). */
describe("la page Nouveautés 10.40", () => {
  it("passe telle quelle dans les bornes de l'éditeur, de même forme dans les quatre langues", () => {
    const shape = (lang: (typeof NEWS_LANGS)[number]) => NEWS_1040_CONTENT[lang]!.sections.map((s) => s.entries.map((e) => e.icon));
    for (const lang of NEWS_LANGS) {
      expect(NEWS_1040_CONTENT[lang], lang).toBeTruthy();
      expect(sanitizeContent(NEWS_1040_CONTENT[lang]), lang).toEqual(NEWS_1040_CONTENT[lang]);
      expect(shape(lang), lang).toEqual(shape("fr"));
    }
  });

  it("vouvoie, ne dit rien de la fabrication, et nomme la pastille comme le lecteur", () => {
    for (const lang of NEWS_LANGS) {
      expect(JSON.stringify(NEWS_1040_CONTENT[lang]), lang).not.toMatch(/dashboard|tableau de bord|\bstack\b|Jellyfin|\bIA\b|\bAI\b|\bKI\b|bêta|beta|Lab\b/i);
    }
    expect(JSON.stringify(NEWS_1040_CONTENT.fr)).not.toMatch(/\b(tu|ton|ta|tes|toi)\b|-toi\b/);
    expect(JSON.stringify(NEWS_1040_CONTENT.de)).not.toMatch(/\b(du|dein|deine|dich|dir)\b/);
    expect(JSON.stringify(NEWS_1040_CONTENT.fr)).toContain("Sous-titres pour ce passage");
  });
});
