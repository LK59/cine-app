import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import fs from "node:fs";

/**
 * Le « vu » d'un compte (DECISIONS.md §51) : Jellyfin fait foi tant qu'il a le titre, la copie
 * locale garde tout, une série se marque sans ses épisodes.
 */
const dir = vi.hoisted(() => {
  // Chargés ici : `vi.hoisted` passe avant les imports du fichier.
  const fsm = require("node:fs") as typeof import("node:fs");
  const osm = require("node:os") as typeof import("node:os");
  const pathm = require("node:path") as typeof import("node:path");
  return fsm.mkdtempSync(pathm.join(osm.tmpdir(), "cine-watched-"));
});
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

const fake = vi.hoisted(() => ({
  movies: [] as { Id: string; ProviderIds: Record<string, string> }[],
  series: [] as { Id: string; ProviderIds: Record<string, string> }[],
  played: [] as Record<string, unknown>[],
  libraryDown: false,
  jellyfinDown: false,
  calls: [] as string[],
}));
vi.mock("@/lib/server-cache", () => ({
  cachedJellyfinMoviesAdmin: async () => {
    if (fake.libraryDown) throw new Error("down");
    return fake.movies;
  },
  cachedJellyfinSeriesAdmin: async () => {
    if (fake.libraryDown) throw new Error("down");
    return fake.series;
  },
  cachedJellyfinPlayed: async () => {
    if (fake.jellyfinDown) throw new Error("down");
    return fake.played;
  },
  getProviderIdCI: (ids: Record<string, string> | undefined, key: string) => ids?.[key[0].toUpperCase() + key.slice(1)],
  invalidateKey: vi.fn(),
}));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    markPlayed: async (_u: string, id: string) => void fake.calls.push(`played:${id}`),
    markUnplayed: async (_u: string, id: string) => void fake.calls.push(`unplayed:${id}`),
  },
}));

import { setWatched, syncWatched, withoutWatched, seriesStillHidden, libraryIndex, resetWatchedSyncForTests, watchedRows } from "@/lib/watched";
import { getDb, watchedDb } from "@/lib/db";

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const who = { userId: "jf-1", jfId: "jf-1" };
const rows = () => watchedRows("jf-1").map((r) => `${r.mediaType}:${r.tmdbId}${r.manual ? ":manuel" : ""}${r.jfPresent ? ":présent" : ""}`).sort();

beforeEach(() => {
  getDb().exec("DELETE FROM watched_titles");
  fake.movies = [{ Id: "m-dune", ProviderIds: { Tmdb: "438631" } }];
  fake.series = [{ Id: "s-lasso", ProviderIds: { Tmdb: "97546" } }];
  fake.played = [];
  fake.libraryDown = false;
  fake.jellyfinDown = false;
  fake.calls = [];
  resetWatchedSyncForTests();
});

describe("marquer un titre", () => {
  it("un film de la bibliothèque : écrit chez Jellyfin, et gardé chez nous", async () => {
    await setWatched(who, "movie", 438631, true, { title: "Dune" });
    expect(fake.calls).toEqual(["played:m-dune"]);
    expect(rows()).toEqual(["movie:438631:présent"]);
    await setWatched(who, "movie", 438631, false);
    expect(fake.calls).toEqual(["played:m-dune", "unplayed:m-dune"]);
    expect(rows()).toEqual([]);
  });

  it("un film que la bibliothèque n'a pas : gardé chez nous seulement", async () => {
    await setWatched(who, "movie", 603, true, { title: "Matrix", posterPath: "/m.jpg" });
    expect(fake.calls).toEqual([]);
    expect(rows()).toEqual(["movie:603"]);
    expect(watchedDb.get("jf-1", "movie", 603)?.posterPath).toBe("/m.jpg");
  });

  it("une série : l'état de série seulement, aucun épisode coché chez Jellyfin", async () => {
    await setWatched(who, "series", 97546, true);
    expect(fake.calls).toEqual([]);
    expect(rows()).toEqual(["series:97546:manuel:présent"]);
  });

  it("démarquer une série dont tous les épisodes sont vus : elle reste vue, et on le dit", async () => {
    fake.played = [{ Id: "s-lasso", Type: "Series", Name: "Ted Lasso", ProviderIds: { Tmdb: "97546" } }];
    await setWatched(who, "series", 97546, true);
    expect(await setWatched(who, "series", 97546, false)).toEqual({ watched: true, stillWatched: true });
  });
});

describe("la synchronisation avec Jellyfin", () => {
  it("copie ce que Jellyfin a vu, avec sa date", async () => {
    fake.played = [{ Id: "m-dune", Type: "Movie", Name: "Dune", ProviderIds: { Tmdb: "438631" }, UserData: { Played: true, LastPlayedDate: "2026-01-02T00:00:00Z" } }];
    await syncWatched(who, { force: true });
    expect(rows()).toEqual(["movie:438631:présent"]);
    expect(watchedDb.get("jf-1", "movie", 438631)?.watchedAt).toBe(Date.parse("2026-01-02T00:00:00Z"));
  });

  it("suit un démarquage fait chez Jellyfin (la dernière modification gagne)", async () => {
    await setWatched(who, "movie", 438631, true);
    fake.calls = [];
    await syncWatched(who, { force: true }); // Jellyfin ne le dit plus vu
    expect(rows()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("reporte chez Jellyfin le vu d'un titre qui vient d'arriver", async () => {
    await setWatched(who, "movie", 603, true); // absent : copie seule
    fake.movies.push({ Id: "m-matrix", ProviderIds: { Tmdb: "603" } });
    await syncWatched(who, { force: true });
    expect(fake.calls).toEqual(["played:m-matrix"]);
    expect(rows()).toEqual(["movie:603:présent"]);
  });

  it("garde le vu d'un titre parti de la bibliothèque", async () => {
    await setWatched(who, "movie", 438631, true);
    fake.movies = [];
    await syncWatched(who, { force: true });
    expect(rows()).toEqual(["movie:438631"]);
  });

  it("ne décide rien quand Jellyfin ou la bibliothèque ne répond pas", async () => {
    await setWatched(who, "movie", 438631, true);
    fake.libraryDown = true;
    await syncWatched(who, { force: true });
    expect(rows()).toEqual(["movie:438631:présent"]);
    fake.libraryDown = false;
    fake.jellyfinDown = true;
    await syncWatched(who, { force: true });
    expect(rows()).toEqual(["movie:438631:présent"]);
  });

  it("une série entièrement vue qui ne l'est plus (nouvel épisode) reste vue, comme marquée ce jour-là", async () => {
    fake.played = [{ Id: "s-lasso", Type: "Series", Name: "Ted Lasso", ProviderIds: { Tmdb: "97546" } }];
    await syncWatched(who, { force: true });
    fake.played = [];
    await syncWatched(who, { force: true });
    expect(rows()).toEqual(["series:97546:manuel:présent"]);
  });

  it("au plus une fois par minute et par compte", async () => {
    fake.played = [{ Id: "m-dune", Type: "Movie", Name: "Dune", ProviderIds: { Tmdb: "438631" } }];
    await syncWatched(who, { now: 1_000_000 });
    fake.played = [];
    await syncWatched(who, { now: 1_030_000 });
    expect(rows()).toEqual(["movie:438631:présent"]);
  });
});

describe("Reprendre et À suivre", () => {
  it("cachent une série vue, sauf un épisode entré après le marquage", async () => {
    watchedDb.upsert({ userId: "jf-1", mediaType: "series", tmdbId: 97546, title: "", year: null, posterPath: null, manual: true, jfPresent: true, jfPlayed: false, watchedAt: Date.parse("2026-05-01T00:00:00Z") });
    const index = await libraryIndex();
    const items = [
      { Id: "e1", Name: "S1E5", Type: "Episode", SeriesId: "s-lasso", DateCreated: "2026-01-01T00:00:00Z" },
      { Id: "e2", Name: "S4E1", Type: "Episode", SeriesId: "s-lasso", DateCreated: "2026-09-01T00:00:00Z" },
    ];
    expect(withoutWatched("jf-1", items, index).map((i) => i.Id)).toEqual(["e2"]);
  });

  it("cachent un film marqué vu depuis sa dernière lecture, pas un film revu après", async () => {
    watchedDb.upsert({ userId: "jf-1", mediaType: "movie", tmdbId: 438631, title: "", year: null, posterPath: null, manual: false, jfPresent: true, jfPlayed: true, watchedAt: Date.parse("2026-05-01T00:00:00Z") });
    const index = await libraryIndex();
    const before = [{ Id: "m-dune", Name: "Dune", Type: "Movie", UserData: { Played: false, PlayCount: 0, LastPlayedDate: "2026-04-01T00:00:00Z" } }];
    const after = [{ Id: "m-dune", Name: "Dune", Type: "Movie", UserData: { Played: false, PlayCount: 0, LastPlayedDate: "2026-06-01T00:00:00Z" } }];
    expect(withoutWatched("jf-1", before, index)).toEqual([]);
    expect(withoutWatched("jf-1", after, index)).toHaveLength(1);
  });

  it("ne cache rien sans date d'entrée connue", () => {
    expect(seriesStillHidden(1000, undefined)).toBe(false);
    expect(seriesStillHidden(undefined, "2026-01-01")).toBe(false);
  });
});
