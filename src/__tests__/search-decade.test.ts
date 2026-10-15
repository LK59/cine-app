import { describe, it, expect } from "vitest";
import {
  extractDecade,
  normalize,
  parseNaturalQuery,
  parseNaturalQueryDE,
  parseNaturalQueryEN,
  parseNaturalQueryES,
} from "@/lib/search-natural-query";
import { searchCinemaLibrary } from "@/lib/cinemaSearch";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

/**
 * Les décennies dans la recherche (15/10/2026, passe de nuit, BUREAU-25, DECISIONS.md §99) :
 * « films d'horreur des années 80 » comprenait l'horreur et ignorait la décennie — les premiers
 * résultats étaient tous de 2026.
 */

function movie(id: number, title: string, year: number, genres: string[], imdbRating: string | null = null): CinemaMovie {
  return { radarrId: id, jellyfinItemId: `jf-${id}`, tmdbId: id, title, year, posterUrl: null, backdropUrl: null, logoUrl: null, overview: null, imdbRating, genres } as CinemaMovie;
}
function series(id: number, title: string, year: number, genres: string[]): CinemaSeries {
  return { sonarrId: id, jellyfinItemId: `jf-s${id}`, tvdbId: id, tmdbId: id, title, year, posterUrl: null, backdropUrl: null, logoUrl: null, overview: null, imdbRating: null, genres } as CinemaSeries;
}

const LIBRARY = [
  movie(1, "The Thing", 1982, ["Horror", "Science Fiction"], "8.2"),
  movie(2, "La Mouche", 1986, ["Horror", "Science Fiction"], "7.6"),
  movie(3, "Resident Evil", 2026, ["Horror", "Action"], "6.0"),
  movie(4, "Un jour sans fin", 1993, ["Comedy", "Romance"], "8.0"),
  movie(5, "Zootopie 2", 2025, ["Comedy", "Animation"], "7.5"),
  movie(6, "Big", 1988, ["Comedy", "Fantasy"], "7.3"),
  movie(7, "1917", 2019, ["War"], "8.2"),
  movie(8, "2001 : L'Odyssée de l'espace", 1968, ["Science Fiction"], "8.3"),
  movie(9, "Apollo 13", 1995, ["Drama", "History"], "7.7"),
  movie(10, "2010 : L'Année du premier contact", 1984, ["Science Fiction"], "6.8"),
];
const SERIES = [series(20, "That '70s Show", 1998, ["Comedy"])];

const titles = (q: string, locale: "fr" | "en" | "es" | "de" = "fr") =>
  searchCinemaLibrary(q, LIBRARY, SERIES, locale).map((r) => r.item.title);

describe("extractDecade — les tournures des quatre langues", () => {
  it.each([
    ["films d'horreur des années 80", 1980],
    ["comédie des années 90", 1990],
    ["les années 1980", 1980],
    ["années 2000", 2000],
    ["années 20", 1920],
    ["années quatre-vingt", 1980],
    ["années soixante-dix", 1970],
    ["80s horror movies", 1980],
    ["horror from the 1980s", 1980],
    ["eighties comedies", 1980],
    ["películas de terror de los 80", 1980],
    ["comedias de los años 90", 1990],
    ["los ochenta", 1980],
    ["Horrorfilme der 80er", 1980],
    ["Komödien aus den 80ern", 1980],
    ["80er Jahre Komödie", 1980],
    ["achtziger Jahre", 1980],
  ])("%s → %i", (q, decade) => {
    expect(extractDecade(normalize(q)).decade).toBe(decade);
  });

  it.each(["2001", "Apollo 13", "1917", "2010", "Blade Runner 2049", "Les Quarante Rugissants", "Ocean's Eleven", "Los 400 golpes", "8 Mile"])(
    "un nombre seul reste un titre : %s",
    (q) => {
      expect(extractDecade(normalize(q)).decade).toBeNull();
    }
  );

  it("chaque langue a sa tournure, et le parseur la remonte avec le genre", () => {
    expect(parseNaturalQuery("films d'horreur des années 80", "all")).toMatchObject({ enabled: true, genreName: "horror", decade: 1980, mediaType: "movie" });
    expect(parseNaturalQueryEN("80s horror movies", "all")).toMatchObject({ enabled: true, genreName: "horror", decade: 1980 });
    expect(parseNaturalQueryES("películas de terror de los años 80", "all")).toMatchObject({ enabled: true, genreName: "horror", decade: 1980 });
    expect(parseNaturalQueryDE("Horrorfilme der 80er", "all")).toMatchObject({ enabled: true, decade: 1980 });
    expect(parseNaturalQuery("Apollo 13", "all")).toMatchObject({ enabled: false, decade: null });
  });
});

describe("la recherche du cinéma filtre par décennie", () => {
  it("« films d'horreur des années 80 » : les films d'horreur des années 80, pas ceux de 2026", () => {
    expect(titles("films d'horreur des années 80")).toEqual(["The Thing", "La Mouche"]);
  });

  it("« comédie des années 90 », « années 1980 », « 80s comedy », « los 80 », « 80er » dans leur langue", () => {
    // La série de 1998 est bien des années 90.
    expect(titles("comédie des années 90")).toEqual(["Un jour sans fin", "That '70s Show"]);
    expect(titles("films des années 1980")).toEqual(["The Thing", "La Mouche", "Big", "2010 : L'Année du premier contact"]);
    expect(titles("80s comedy movies", "en")).toEqual(["Big"]);
    expect(titles("comedia de los 80", "es")).toEqual(["Big"]);
    expect(titles("Komödie der 80er", "de")).toEqual(["Big"]);
  });

  it("les titres qui portent un nombre se trouvent comme avant", () => {
    expect(titles("1917")).toEqual(["1917"]);
    expect(titles("2001")).toContain("2001 : L'Odyssée de l'espace");
    expect(titles("Apollo 13")).toEqual(["Apollo 13"]);
    expect(titles("2010")).toContain("2010 : L'Année du premier contact");
  });

  it("un titre qui contient la tournure se trouve hors de sa décennie : « That '70s Show » (1998)", () => {
    expect(titles("that 70s show", "en")).toEqual(["That '70s Show"]);
  });
});
