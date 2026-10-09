import { describe, it, expect, vi } from "vitest";

/**
 * Les deux règles du 09/10/2026 (DECISIONS.md §58) : le titre d'une langue est celui de son pays de
 * référence — vide, il vaut le titre original —, et le logo suit la langue du titre affiché.
 */
vi.mock("@/lib/db", () => ({ kvCacheDb: { get: () => null, set: () => {} } }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { namesFromTranslations } from "@/lib/titleNames";
import { logoForLocale, pickLogosByLang, type TitleArt } from "@/lib/title-art";

const tr = (lang: string, country: string, title: string) => ({ iso_639_1: lang, iso_3166_1: country, data: { title, name: title } });

describe("le titre d'une langue", () => {
  it("vaut le titre original quand la fiche de France existe mais est vide — pas le titre québécois", () => {
    const names = namesFromTranslations({
      original_language: "en",
      original_title: "Pulp Fiction",
      translations: { translations: [tr("fr", "FR", ""), tr("fr", "CA", "Fiction pulpeuse")] },
    });
    expect(names.fr).toBe("Pulp Fiction");
    expect(names.original).toBe("Pulp Fiction");
    expect(names.originalLanguage).toBe("en");
  });

  it("garde le titre de France quand il est rempli", () => {
    const names = namesFromTranslations({
      original_language: "en",
      original_title: "The Godfather",
      translations: { translations: [tr("fr", "CA", "Le Parrain (Québec)"), tr("fr", "FR", "Le Parrain")] },
    });
    expect(names.fr).toBe("Le Parrain");
  });

  it("sans fiche de France, prend comme avant le premier titre non vide de la langue", () => {
    const names = namesFromTranslations({
      original_language: "en",
      original_title: "Rush Hour",
      translations: { translations: [tr("fr", "CA", "Heure limite")] },
    });
    expect(names.fr).toBe("Heure limite");
  });

  it("en anglais : la fiche des États-Unis décide, sinon celle du Royaume-Uni, vide comprise", () => {
    // Pas de fiche américaine, fiche britannique vide : le titre original.
    const names = namesFromTranslations({
      original_language: "fr",
      original_title: "Le Fabuleux Destin d'Amélie Poulain",
      translations: { translations: [tr("en", "GB", ""), tr("en", "AU", "Amelie (Australie)")] },
    });
    expect(names.en).toBe("Le Fabuleux Destin d'Amélie Poulain");
    // Les deux existent : les États-Unis passent devant.
    const both = namesFromTranslations({
      original_language: "fr",
      original_title: "Intouchables",
      translations: { translations: [tr("en", "GB", "Untouchable"), tr("en", "US", "The Intouchables")] },
    });
    expect(both.en).toBe("The Intouchables");
  });
});

describe("le logo", () => {
  const look = (map: Record<string, { dark: boolean | null; saturation: number | null }>) => async (file: string) => map[file];
  const logo = (lang: string | null, file: string, vote = 0) => ({ iso_639_1: lang, file_path: file, vote_average: vote, vote_count: 0, width: 400, height: 100, aspect_ratio: 4 });

  it("à égalité de votes, préfère la version colorée lisible — jamais une trop sombre", async () => {
    const byLang = await pickLogosByLang(
      [logo("en", "/blanc.png"), logo("en", "/rouge.png"), logo("fr", "/noir.png"), logo("fr", "/blanc-fr.png")],
      look({
        "/blanc.png": { dark: false, saturation: 0 },
        "/rouge.png": { dark: false, saturation: 0.95 },
        "/noir.png": { dark: true, saturation: 0 },
        "/blanc-fr.png": { dark: false, saturation: 0 },
      }),
    );
    expect(byLang.en).toContain("/rouge.png");
    expect(byLang.fr).toContain("/blanc-fr.png");
  });

  it("suit la langue du titre affiché : original → langue d'origine, traduit → langue de qui regarde", () => {
    const art: TitleArt = {
      logoUrl: "fr-ancien",
      logosByLang: { en: "logo-en", fr: "logo-fr", null: "logo-muet" },
      posterTextlessUrl: null,
      posterByLang: {},
    };
    const original = { fr: "The End of the F***ing World", original: "The End of the F***ing World", originalLanguage: "en" };
    expect(logoForLocale(art, original, "fr")).toBe("logo-en");
    const translated = { fr: "Le Parrain", en: "The Godfather", original: "The Godfather", originalLanguage: "en" };
    expect(logoForLocale(art, translated, "fr")).toBe("logo-fr");
    expect(logoForLocale(art, translated, "en")).toBe("logo-en");
    // Pas de logo dans la langue voulue : sans texte, puis anglais.
    expect(logoForLocale({ ...art, logosByLang: { null: "logo-muet", en: "logo-en" } }, translated, "fr")).toBe("logo-muet");
  });

  it("une entrée d'avant le 09/10/2026, sans logos par langue, garde son ancien logo", () => {
    expect(logoForLocale({ logoUrl: "ancien", posterTextlessUrl: null, posterByLang: {} }, { fr: "X" }, "fr")).toBe("ancien");
  });
});
