import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Le panneau d'une personne d'« À l'écran », côté serveur (DECISIONS.md §138, 10.27) : la personne est
 * cherchée dans la distribution de **cet** élément ; la biographie est choisie par la règle des fiches
 * personne (`selectBio` : TMDB, sinon Wikipédia) par le même chemin (`src/lib/tmdbPerson.ts`) ; ses
 * autres titres viennent de sa filmographie reliée à la bibliothèque — tags bloqués appliqués par ce
 * chemin —, sans le titre regardé, trois au plus. Rien ne lève : une panne répond `none`.
 */

const cast = vi.hoisted(() => ({ people: [{ personId: 7, name: "Lucas Till", character: "Angus MacGyver", order: 0, profilePath: "/lt.jpg" }] }));
vi.mock("@/lib/xray/cast", () => ({
  analysisTarget: async () => ({ itemId: "a".repeat(32), type: "Episode", path: "/m.mkv", etag: "v1", seriesId: null, tmdb: { kind: "episode", tvId: 100, season: 1, episode: 1 } }),
  castOf: async () => cast.people,
}));
const person = vi.hoisted(() => ({
  details: { biography: "", birthday: "1990-08-10", deathday: null, place_of_birth: "Fort Hood, Texas, USA" } as Record<string, unknown> | null,
  wikiBio: "Lucas Till est un acteur américain." as string | null,
  filmography: [] as { tmdbId: number; mediaType: "movie" | "tv"; title: string; year: number | null; posterPath: string | null; inLibrary: boolean }[],
  jfSeen: [] as unknown[],
}));
vi.mock("@/lib/tmdbPerson", () => ({
  personDetailsCached: async () => person.details,
  personWithBiography: async (d: unknown) => d,
  personCreditsCached: async () => ({ cast: [] }),
  enrichedPerson: async () => ({ photos: [], instagram: null, imdb: null, wikipedia: null, wikiBio: person.wikiBio }),
  personFilmography: async (_cast: unknown, jfId: unknown) => {
    person.jfSeen.push(jfId);
    return person.filmography;
  },
}));
vi.mock("@/lib/clients/tmdb", () => ({ createTmdbClient: () => ({ isEnabled: () => true }) }));
const logError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));

import { personFactsForPlayer, XRAY_LIBRARY_MAX } from "@/lib/xray/person";

beforeEach(() => {
  person.filmography = [
    { tmdbId: 100, mediaType: "tv", title: "MacGyver", year: 2016, posterPath: "/mac.jpg", inLibrary: true },
    { tmdbId: 1, mediaType: "movie", title: "Bumblebee", year: 2018, posterPath: "/bb.jpg", inLibrary: true },
    { tmdbId: 2, mediaType: "movie", title: "X-Men: First Class", year: 2011, posterPath: null, inLibrary: true },
    { tmdbId: 3, mediaType: "movie", title: "Monster Trucks", year: 2016, posterPath: "/mt.jpg", inLibrary: false },
    { tmdbId: 4, mediaType: "movie", title: "Walk the Line", year: 2005, posterPath: "/wl.jpg", inLibrary: true },
    { tmdbId: 5, mediaType: "movie", title: "The Spellcaster", year: 2020, posterPath: "/sc.jpg", inLibrary: true },
  ];
  person.jfSeen = [];
  logError.mockReset();
});

describe("personFactsForPlayer", () => {
  it("âge, lieu, biographie (Wikipédia quand TMDB n'a rien), et trois autres titres de la bibliothèque — jamais celui qu'on regarde", async () => {
    const facts = await personFactsForPlayer("a".repeat(32), 7, "fr", "f".repeat(32));
    expect(facts).toMatchObject({ status: "ok", birthday: "1990-08-10", placeOfBirth: "Fort Hood, Texas, USA", bio: "Lucas Till est un acteur américain." });
    expect(facts.library!.map((c) => c.title)).toEqual(["Bumblebee", "X-Men: First Class", "Walk the Line"]);
    expect(facts.library).toHaveLength(XRAY_LIBRARY_MAX);
    expect(facts.library![0].poster).toBe("https://image.tmdb.org/t/p/w185/bb.jpg");
    // La filmographie est lue pour ce compte : ses tags bloqués s'y appliquent.
    expect(person.jfSeen).toEqual(["f".repeat(32)]);
  });

  it("`library: false` (un lien de partage, 10.28.1) : les faits et la biographie, ni filmographie lue ni autres titres", async () => {
    const facts = await personFactsForPlayer("a".repeat(32), 7, "fr", "f".repeat(32), { library: false });
    expect(facts).toMatchObject({ status: "ok", birthday: "1990-08-10", placeOfBirth: "Fort Hood, Texas, USA", bio: "Lucas Till est un acteur américain." });
    expect(facts).not.toHaveProperty("library");
    expect(person.jfSeen).toEqual([]);
  });

  it("une personne absente de la distribution de cet élément : `none`, rien d'autre de lu", async () => {
    expect(await personFactsForPlayer("a".repeat(32), 999, "fr", null)).toEqual({ status: "none" });
    expect(person.jfSeen).toEqual([]);
  });

  it("une panne : `none` au panneau, la cause au journal du serveur — jamais une erreur qui remonte", async () => {
    person.details = null;
    const original = person.filmography;
    Object.defineProperty(person, "filmography", { get: () => { throw new Error("TMDB injoignable"); }, configurable: true });
    try {
      expect(await personFactsForPlayer("a".repeat(32), 7, "fr", null)).toEqual({ status: "none" });
      expect(logError).toHaveBeenCalledWith("xray/person", expect.any(Error), expect.anything());
    } finally {
      Object.defineProperty(person, "filmography", { value: original, writable: true, configurable: true });
    }
  });
});
