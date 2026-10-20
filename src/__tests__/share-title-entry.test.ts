import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `shareTitleEntry` (DECISIONS.md §112) : la carte du titre d'un lien, par les fonctions mêmes du
 * catalogue (`cinemaEntries.ts`, ce que Jellyfin a seul), pour ce titre et lui seul — aucune autre
 * carte n'est construite, donc aucune ne peut fuir vers l'invité.
 */

const MOVIE = "a".repeat(32);
const OTHER = "b".repeat(32);
const SERIES = "c".repeat(32);
const ONLY = "d".repeat(32);

const lists = vi.hoisted(() => ({
  movies: [] as unknown[],
  jfMovies: [] as unknown[],
  series: [] as unknown[],
  jfSeries: [] as unknown[],
  firstEpisodes: [] as unknown[],
  seasons: [] as unknown[],
}));
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: async () => lists.movies,
  cachedJellyfinMoviesAdmin: async () => lists.jfMovies,
  cachedSeries: async () => lists.series,
  cachedJellyfinSeriesAdmin: async () => lists.jfSeries,
  cachedJellyfinFirstEpisodes: async () => lists.firstEpisodes,
  cachedJellyfinSeasons: async () => lists.seasons,
  cachedJellyfinRecentEpisodes: async () => [],
}));

// Le rapprochement réel est testé ailleurs (`catalogueMembers`) : ici, chaque élément a son titre.
const only = vi.hoisted(() => ({ movies: [] as unknown[], series: [] as unknown[] }));
vi.mock("@/lib/catalogueMembers", () => ({
  matchMovies: (movies: { id: number; jf: string }[], jf: { Id: string }[]) =>
    movies.map((m) => ({ m, jfItem: jf.find((i) => i.Id === m.jf)! })).filter((x) => x.jfItem),
  matchSeries: (series: { id: number; jf: string }[], jf: { Id: string }[]) =>
    series.map((s) => ({ s, jfItem: jf.find((i) => i.Id === s.jf)! })).filter((x) => x.jfItem),
  jellyfinOnlyMovies: () => only.movies,
  jellyfinOnlySeries: async () => only.series,
}));

const built = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/lib/cinemaEntries", () => ({
  toCinemaMovie: async (...args: unknown[]) => {
    built.calls.push(["movie", ...args]);
    return { radarrId: (args[0] as { id: number }).id, jellyfinItemId: args[1] };
  },
  toCinemaSeries: async (...args: unknown[]) => {
    built.calls.push(["series", ...args]);
    return { sonarrId: (args[0] as { id: number }).id, jellyfinItemId: (args[1] as { Id: string }).Id };
  },
}));
vi.mock("@/lib/jellyfinOnlyCatalogue", () => ({
  jellyfinOnlyCinemaMovie: async (t: { id: number; item: { Id: string } }) => {
    built.calls.push(["only-movie", t]);
    return { radarrId: t.id, source: "jellyfin", jellyfinItemId: t.item.Id };
  },
  jellyfinOnlyCinemaSeries: async (t: { id: number; item: { Id: string } }, _l: unknown, first: unknown, count: unknown) => {
    built.calls.push(["only-series", t, first, count]);
    return { sonarrId: t.id, source: "jellyfin", jellyfinItemId: t.item.Id };
  },
}));

import { shareTitleEntry } from "@/lib/share/title";

beforeEach(() => {
  built.calls = [];
  lists.movies = [
    { id: 1, jf: OTHER },
    { id: 2, jf: MOVIE },
  ];
  lists.jfMovies = [{ Id: OTHER }, { Id: MOVIE }];
  lists.series = [{ id: 7, jf: SERIES, added: "2026-01-01T00:00:00Z" }];
  lists.jfSeries = [{ Id: SERIES, DateCreated: "2026-01-01T00:00:00Z" }];
  lists.firstEpisodes = [
    { Id: "e".repeat(32), SeriesId: OTHER, RunTimeTicks: 1 },
    { Id: "f".repeat(32), SeriesId: SERIES, RunTimeTicks: 42 },
  ];
  lists.seasons = [
    { SeriesId: SERIES, IndexNumber: 1, ChildCount: 8 },
    { SeriesId: SERIES, IndexNumber: 2, ChildCount: 0 },
    { SeriesId: SERIES, IndexNumber: 0, ChildCount: 2 },
    { SeriesId: OTHER, IndexNumber: 1, ChildCount: 3 },
  ];
  only.movies = [];
  only.series = [];
});

describe("shareTitleEntry", () => {
  it("un film : la carte du catalogue pour lui, et aucune autre construite", async () => {
    const card = await shareTitleEntry({ kind: "movie", itemId: MOVIE }, "fr");
    expect(card).toEqual({ radarrId: 2, jellyfinItemId: MOVIE });
    expect(built.calls).toEqual([["movie", { id: 2, jf: MOVIE }, MOVIE, "fr"]]);
  });

  it("l'identifiant du lien se compare sans tenir compte de la casse", async () => {
    lists.jfMovies = [{ Id: OTHER }, { Id: MOVIE.toUpperCase() }];
    lists.movies = [{ id: 2, jf: MOVIE.toUpperCase() }];
    expect(await shareTitleEntry({ kind: "movie", itemId: MOVIE }, "fr")).toMatchObject({ radarrId: 2 });
  });

  it("un film que Jellyfin a seul (§89) : sa carte à lui, avec son identifiant réservé", async () => {
    only.movies = [{ id: 900_000_001, item: { Id: ONLY } }];
    expect(await shareTitleEntry({ kind: "movie", itemId: ONLY }, "fr")).toEqual({ radarrId: 900_000_001, source: "jellyfin", jellyfinItemId: ONLY });
    expect(built.calls.map((c) => c[0])).toEqual(["only-movie"]);
  });

  it("un titre que le catalogue ne montre pas : rien", async () => {
    expect(await shareTitleEntry({ kind: "movie", itemId: SERIES }, "fr")).toBeNull();
    expect(await shareTitleEntry({ kind: "series", itemId: MOVIE }, "fr")).toBeNull();
    expect(built.calls).toEqual([]);
  });

  it("une série : son premier épisode et ses saisons non vides, comme la route des séries", async () => {
    const card = await shareTitleEntry({ kind: "series", itemId: SERIES }, "fr");
    expect(card).toEqual({ sonarrId: 7, jellyfinItemId: SERIES });
    expect(built.calls).toHaveLength(1);
    const [, s, jfItem, locale, firstEpisode, seasonCount, freshness] = built.calls[0];
    expect(s).toMatchObject({ id: 7 });
    expect(jfItem).toMatchObject({ Id: SERIES });
    expect(locale).toBe("fr");
    expect(firstEpisode).toEqual({ itemId: "f".repeat(32), runtimeTicks: 42 });
    expect(seasonCount).toBe(2);
    expect(freshness).toHaveProperty("addedAt");
  });

  it("une série que Jellyfin a seule", async () => {
    lists.series = [];
    lists.jfSeries = [{ Id: ONLY }];
    only.series = [{ id: 900_000_002, item: { Id: ONLY } }];
    expect(await shareTitleEntry({ kind: "series", itemId: ONLY }, "en")).toMatchObject({ sonarrId: 900_000_002, source: "jellyfin" });
  });
});
