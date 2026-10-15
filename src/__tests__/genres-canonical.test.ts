import { describe, expect, it } from "vitest";
import { canonicalGenres } from "@/lib/genres";
import { genreLabel } from "@/lib/top10Label";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";

// Un genre, un nom (07/10/2026) : « Horreur » et « Horror » faisaient deux rangées et deux entrées
// de filtre, chacune avec la moitié des films.
describe("canonicalGenres", () => {
  it("ramène les noms traduits à la clé anglaise des dictionnaires", () => {
    expect(canonicalGenres(["Horreur"])).toEqual(["Horror"]);
    expect(canonicalGenres(["Comédie", "comedy"])).toEqual(["Comedy"]);
    expect(canonicalGenres(["Terror", "Komödie", "Ciencia ficción"])).toEqual(["Horror", "Comedy", "Science Fiction"]);
  });

  it("ignore la casse, les accents et la ponctuation", () => {
    expect(canonicalGenres(["SCIENCE-FICTION", "Sci-Fi", "science fiction"])).toEqual(["Science Fiction"]);
  });

  it("découpe les genres composés des séries", () => {
    expect(canonicalGenres(["Action & Adventure", "Sci-Fi & Fantasy", "War & Politics"])).toEqual(["Action", "Adventure", "Science Fiction", "Fantasy", "War"]);
  });

  it("garde distincts les genres que Sonarr distingue", () => {
    expect(canonicalGenres(["Suspense", "Thriller", "Musical", "Music"])).toEqual(["Suspense", "Thriller", "Musical", "Music"]);
  });

  // « Martial Arts » et « Soap » servaient d'exemple de genre inconnu ; ils ont leur traduction
  // depuis le 15/10/2026 (ci-dessous) — l'exemple a changé, la règle non.
  it("garde tel quel un genre inconnu, sans le perdre", () => {
    expect(canonicalGenres(["Kaiju", "Wuxia"])).toEqual(["Kaiju", "Wuxia"]);
    expect(canonicalGenres(null)).toEqual([]);
  });
});

// 15/10/2026 (passe de nuit, BUREAU-4) : deux rangées de l'onglet Séries restaient en anglais,
// « Martial Arts » et « Soap », au milieu de « Comédie musicale » et « Téléréalité ».
describe("les genres des séries de Sonarr sont traduits", () => {
  const DICTS = { fr, en, es, de } as const;
  it.each([
    ["fr", "Arts martiaux", "Feuilleton"],
    ["en", "Martial Arts", "Soap"],
    ["es", "Artes marciales", "Telenovela"],
    ["de", "Kampfsport", "Seifenoper"],
  ] as const)("%s", (locale, martial, soap) => {
    const t = createT(DICTS[locale] as Record<string, unknown>, fr as Record<string, unknown>, locale);
    expect(genreLabel("Martial Arts", t)).toBe(martial);
    expect(genreLabel("Soap", t)).toBe(soap);
  });

  it("et un nom traduit revient à sa clé", () => {
    expect(canonicalGenres(["Arts martiaux", "Seifenoper"])).toEqual(["Martial Arts", "Soap"]);
  });
});
