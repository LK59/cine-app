import { describe, expect, it } from "vitest";
import { canonicalGenres } from "@/lib/genres";

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

  it("garde tel quel un genre inconnu, sans le perdre", () => {
    expect(canonicalGenres(["Martial Arts", "Soap"])).toEqual(["Martial Arts", "Soap"]);
    expect(canonicalGenres(null)).toEqual([]);
  });
});
