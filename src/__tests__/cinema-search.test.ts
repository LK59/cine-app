import { describe, it, expect } from "vitest";
import { searchCinemaLibrary } from "@/lib/cinemaSearch";
import type { CinemaMovie } from "@/app/api/cinema/movies/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

function movie(radarrId: number, title: string, year: number, genres: string[], imdbRating: string | null = null): CinemaMovie {
  return {
    radarrId,
    jellyfinItemId: `jf-${radarrId}`,
    tmdbId: radarrId,
    title,
    year,
    posterUrl: null,
    backdropUrl: null,
    logoUrl: null,
    overview: null,
    imdbRating,
    genres,
  } as CinemaMovie;
}

function series(sonarrId: number, title: string, year: number, genres: string[]): CinemaSeries {
  return {
    sonarrId,
    jellyfinItemId: `jf-s${sonarrId}`,
    tvdbId: sonarrId,
    tmdbId: sonarrId,
    title,
    year,
    posterUrl: null,
    backdropUrl: null,
    logoUrl: null,
    overview: null,
    imdbRating: null,
    genres,
  } as CinemaSeries;
}

const MOVIES = [
  movie(1, "Interstellar", 2014, ["Science Fiction", "Adventure"], "8.7"),
  movie(2, "Mad Max: Fury Road", 2015, ["Action", "Adventure"], "8.1"),
  movie(3, "John Wick", 2014, ["Action", "Thriller"], "7.4"),
];
const SERIES = [
  series(10, "Breaking Bad", 2008, ["Drama", "Crime"]),
  series(11, "The Expanse", 2015, ["Sci-Fi & Fantasy", "Drama"]),
];

describe("searchCinemaLibrary", () => {
  it("matches a title across both media types", () => {
    const r = searchCinemaLibrary("interstellar", MOVIES, SERIES, "fr");
    expect(r).toHaveLength(1);
    expect(r[0].item.title).toBe("Interstellar");

    const s = searchCinemaLibrary("breaking", MOVIES, SERIES, "fr");
    expect(s[0].kind).toBe("series");
  });

  it("tolerates typos, like the global search does", () => {
    const r = searchCinemaLibrary("interstelar", MOVIES, SERIES, "fr");
    expect(r[0]?.item.title).toBe("Interstellar");
  });

  it("lists a whole genre when the query is only a genre phrase", () => {
    const r = searchCinemaLibrary("films d'action", MOVIES, SERIES, "fr");
    expect(r.map((x) => x.item.title).sort()).toEqual(["John Wick", "Mad Max: Fury Road"]);
  });

  it("honours a media-type hint", () => {
    const r = searchCinemaLibrary("séries drame", MOVIES, SERIES, "fr");
    expect(r.every((x) => x.kind === "series")).toBe(true);
    expect(r).toHaveLength(2);
  });

  it("bridges Sonarr's compound genre names", () => {
    const r = searchCinemaLibrary("science fiction", MOVIES, SERIES, "fr");
    expect(r.map((x) => x.item.title).sort()).toEqual(["Interstellar", "The Expanse"]);
  });

  it("filters on a year found in the query", () => {
    const r = searchCinemaLibrary("action 2015", MOVIES, SERIES, "fr");
    expect(r.map((x) => x.item.title)).toEqual(["Mad Max: Fury Road"]);
  });

  it("returns nothing for a too-short or meaningless query", () => {
    expect(searchCinemaLibrary("a", MOVIES, SERIES, "fr")).toEqual([]);
    expect(searchCinemaLibrary("de", MOVIES, SERIES, "fr")).toEqual([]);
    expect(searchCinemaLibrary("zzzz", MOVIES, SERIES, "fr")).toEqual([]);
  });
});
