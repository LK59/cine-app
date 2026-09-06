import { describe, it, expect } from "vitest";
import { browseTitles, sortTitles, decadesOf, BROWSE_ALL, DEFAULT_FILTERS } from "@/lib/cinemaBrowse";

const make = (title: string, year: number, genres: string[], addedAt: string | null, imdbRating: string | null) => ({
  title, year, genres, addedAt, imdbRating,
});

const LIBRARY = [
  make("Alien", 1979, ["Horreur", "Science-Fiction"], "2026-01-02T00:00:00Z", "8.5"),
  make("Élève libre", 2008, ["Drame"], "2026-03-01T00:00:00Z", null),
  make("Rocky 2", 1979, ["Drame"], "2026-02-01T00:00:00Z", "7.3"),
  make("Rocky 10", 2019, ["Drame"], null, "5.0"),
  make("Zodiac", 2007, ["Thriller", "Drame"], "2026-01-20T00:00:00Z", "7.7"),
];

describe("sortTitles", () => {
  it("puts the newest arrivals first", () => {
    expect(sortTitles(LIBRARY, "added").map((t) => t.title)).toEqual([
      "Élève libre", "Rocky 2", "Zodiac", "Alien", "Rocky 10",
    ]);
  });

  // « Rocky 2 » avant « Rocky 10 », et « Élève » à sa place alphabétique et non après « Zodiac ».
  it("sorts titles the way a French reader expects", () => {
    expect(sortTitles(LIBRARY, "title").map((t) => t.title)).toEqual([
      "Alien", "Élève libre", "Rocky 2", "Rocky 10", "Zodiac",
    ]);
  });

  it("sorts by year, newest first", () => {
    expect(sortTitles(LIBRARY, "year").map((t) => t.year)).toEqual([2019, 2008, 2007, 1979, 1979]);
  });

  // Ne pas être noté n'est pas être mauvais — mais ça ne peut pas non plus passer devant.
  it("ranks an unrated title after every rated one", () => {
    expect(sortTitles(LIBRARY, "rating").map((t) => t.title)).toEqual([
      "Alien", "Zodiac", "Rocky 2", "Rocky 10", "Élève libre",
    ]);
  });

  // Deux titres à égalité doivent garder le même ordre d'une visite à l'autre : sans départage,
  // ils se suivent dans l'ordre du serveur, qui n'est pas stable.
  it("breaks every tie on the title, so the grid never reshuffles itself", () => {
    const tied = [make("Boréal", 1979, [], null, null), make("Abyss", 1979, [], null, null)];
    expect(sortTitles(tied, "year").map((t) => t.title)).toEqual(["Abyss", "Boréal"]);
    expect(sortTitles(tied, "added").map((t) => t.title)).toEqual(["Abyss", "Boréal"]);
    expect(sortTitles(tied, "rating").map((t) => t.title)).toEqual(["Abyss", "Boréal"]);
  });

  it("leaves the list it was given alone", () => {
    const original = [...LIBRARY];
    sortTitles(LIBRARY, "title");
    expect(LIBRARY).toEqual(original);
  });
});

describe("decadesOf", () => {
  it("offers only the decades the library actually has", () => {
    expect(decadesOf(LIBRARY)).toEqual([2010, 2000, 1970]);
  });

  it("ignores a title with no year rather than inventing a decade for it", () => {
    expect(decadesOf([make("Sans année", 0, [], null, null)])).toEqual([]);
  });
});

describe("browseTitles", () => {
  it("shows everything by default", () => {
    expect(browseTitles(LIBRARY, DEFAULT_FILTERS)).toHaveLength(5);
  });

  it("keeps only one genre", () => {
    expect(browseTitles(LIBRARY, { ...DEFAULT_FILTERS, genre: "Drame" }).map((t) => t.title)).toEqual([
      "Élève libre", "Rocky 2", "Zodiac", "Rocky 10",
    ]);
  });

  it("keeps only one decade", () => {
    expect(browseTitles(LIBRARY, { ...DEFAULT_FILTERS, decade: 1970 }).map((t) => t.title)).toEqual([
      "Rocky 2", "Alien",
    ]);
  });

  it("narrows on what is typed, whatever the case", () => {
    expect(browseTitles(LIBRARY, { ...DEFAULT_FILTERS, query: "  ROCKY " }).map((t) => t.title)).toEqual([
      "Rocky 2", "Rocky 10",
    ]);
  });

  // Les filtres se cumulent : c'est ce qui permet « les drames des années 70 ».
  it("combines the filters", () => {
    expect(
      browseTitles(LIBRARY, { genre: "Drame", decade: 1970, sort: "title", query: "" }).map((t) => t.title)
    ).toEqual(["Rocky 2"]);
  });

  it("filters before it sorts, and says so by example", () => {
    const kept = browseTitles(LIBRARY, { ...DEFAULT_FILTERS, genre: BROWSE_ALL, sort: "title" });
    expect(kept.map((t) => t.title)).toEqual(["Alien", "Élève libre", "Rocky 2", "Rocky 10", "Zodiac"]);
  });
});
