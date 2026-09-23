import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockTmdb = {
  isEnabled: vi.fn(() => true),
  getCollection: vi.fn(),
  getPersonDetails: vi.fn(),
  getPersonCredits: vi.fn(),
  getPersonImages: vi.fn(),
  getPersonExternalIds: vi.fn(),
};
vi.mock("@/lib/clients/tmdb", () => ({
  createTmdbClient: () => mockTmdb,
  tmdb: mockTmdb,
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "fr-FR", LOCALES: ["fr", "en", "es", "de"] }));
const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...a: unknown[]) => mockCachedMovies(...a),
  cachedSeries: (...a: unknown[]) => mockCachedSeries(...a),
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  // Comme le vrai : un succès est gardé, un échec ne l'est pas.
  withPersistentCache: async (key: string, _ttl: number, fn: () => Promise<unknown>) => {
    if (persisted.has(key)) return persisted.get(key);
    const value = await fn();
    persisted.set(key, value);
    return value;
  },
  TTL: { VERY_LONG: 999_999 },
}));
const persisted = new Map<string, unknown>();
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(): NextRequest {
  return { cookies: { get: () => undefined } } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  persisted.clear();
  mockTmdb.isEnabled.mockReturnValue(true);
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/tmdb/collection/[id]", () => {
  it("returns 400 for id 0", async () => {
    const { GET } = await import("@/app/api/tmdb/collection/[id]/route");
    const res = await GET(fakeReq(), params("0"));
    expect(res.status).toBe(400);
  });

  it("sorts parts by release date and marks in-library items", async () => {
    mockTmdb.getCollection.mockResolvedValue({
      name: "Saga", overview: "o",
      parts: [
        { id: 2, title: "Part 2", release_date: "2020-01-01", poster_path: null, vote_average: 7 },
        { id: 1, title: "Part 1", release_date: "2010-01-01", poster_path: null, vote_average: 7 },
      ],
    });
    // `hasFile` : la filmographie ne relie que ce qui est ouvrable, pas ce que Radarr surveille.
    mockCachedMovies.mockResolvedValue([{ tmdbId: 1, id: 55, hasFile: true }]);
    const { GET } = await import("@/app/api/tmdb/collection/[id]/route");
    const res = await GET(fakeReq(), params("10"));
    const body = await res.json();
    expect(body.parts.map((p: { tmdbId: number }) => p.tmdbId)).toEqual([1, 2]);
    expect(body.parts[0]).toMatchObject({ inLibrary: true, libraryHref: "/radarr/55" });
  });
});

describe("GET /api/tmdb/person/[id]", () => {
  it("returns 400 for id 0", async () => {
    const { GET } = await import("@/app/api/tmdb/person/[id]/route");
    const res = await GET(fakeReq(), params("0"));
    expect(res.status).toBe(400);
  });

  it("deduplicates credits by media type + id, keeping the highest-popularity role", async () => {
    mockTmdb.getPersonDetails.mockResolvedValue({ name: "Actor", biography: "bio fr" });
    mockTmdb.getPersonCredits.mockResolvedValue({
      cast: [
        { id: 1, media_type: "movie", title: "M", character: "A", popularity: 5, vote_average: 7, poster_path: null, release_date: "2020-01-01" },
        { id: 1, media_type: "movie", title: "M", character: "B (uncredited)", popularity: 9, vote_average: 7, poster_path: null, release_date: "2020-01-01" },
      ],
    });
    const { GET } = await import("@/app/api/tmdb/person/[id]/route");
    const res = await GET(fakeReq(), params("5"));
    const body = await res.json();
    expect(body.credits).toHaveLength(1);
    expect(body.credits[0].character).toBe("B (uncredited)");
  });

  it("sorts in-library credits before out-of-library ones regardless of rating", async () => {
    mockTmdb.getPersonDetails.mockResolvedValue({ name: "Actor", biography: "bio" });
    mockTmdb.getPersonCredits.mockResolvedValue({
      cast: [
        { id: 1, media_type: "movie", title: "Not in library", popularity: 1, vote_average: 9, poster_path: null, release_date: "2020-01-01" },
        { id: 2, media_type: "movie", title: "In library", popularity: 1, vote_average: 2, poster_path: null, release_date: "2020-01-01" },
      ],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 2, id: 77, hasFile: true }]);
    const { GET } = await import("@/app/api/tmdb/person/[id]/route");
    const res = await GET(fakeReq(), params("5"));
    const body = await res.json();
    expect(body.credits[0].title).toBe("In library");
  });

  it("falls back to English biography when the French one is empty", async () => {
    mockTmdb.getPersonDetails
      .mockResolvedValueOnce({ name: "Actor", biography: "" })
      .mockResolvedValueOnce({ name: "Actor", biography: "English bio" });
    mockTmdb.getPersonCredits.mockResolvedValue({ cast: [] });
    const { GET } = await import("@/app/api/tmdb/person/[id]/route");
    const res = await GET(fakeReq(), params("5"));
    const body = await res.json();
    expect(body.biography).toBe("English bio");
  });
});

describe("GET /api/tmdb/person/[id]/photos", () => {
  it("returns empty photos when TMDB is disabled", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/tmdb/person/[id]/photos/route");
    const res = await GET(fakeReq(), params("5"));
    expect((await res.json()).photos).toEqual([]);
  });

  it("sorts photos by vote average and caps at 24", async () => {
    mockTmdb.getPersonImages.mockResolvedValue({
      profiles: Array.from({ length: 30 }, (_, i) => ({ file_path: `/p${i}.jpg`, vote_average: i, width: 100, height: 150 })),
    });
    const { GET } = await import("@/app/api/tmdb/person/[id]/photos/route");
    const res = await GET(fakeReq(), params("5"));
    const body = await res.json();
    expect(body.photos).toHaveLength(24);
    expect(body.photos[0].voteAverage).toBe(29);
  });
});

describe("GET /api/tmdb/person/[id]/enriched", () => {
  it("returns an empty payload for an invalid id without calling TMDB", async () => {
    const { GET } = await import("@/app/api/tmdb/person/[id]/enriched/route");
    const res = await GET(fakeReq(), params("0"));
    const body = await res.json();
    expect(body).toEqual({ photos: [], instagram: null, imdb: null, wikipedia: null, wikiBio: null });
    expect(mockTmdb.getPersonImages).not.toHaveBeenCalled();
  });

  it("builds instagram/imdb URLs from external ids", async () => {
    mockTmdb.getPersonImages.mockResolvedValue({ profiles: [] });
    mockTmdb.getPersonExternalIds.mockResolvedValue({ instagram_id: "actor", imdb_id: "nm123", wikidata_id: null });
    mockTmdb.getPersonDetails.mockResolvedValue({ name: "Actor" });
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const { GET } = await import("@/app/api/tmdb/person/[id]/enriched/route");
    const res = await GET(fakeReq(), params("5"));
    const body = await res.json();
    expect(body.instagram).toBe("https://www.instagram.com/actor/");
    expect(body.imdb).toBe("https://www.imdb.com/name/nm123");
  });
});

// Une semaine de cache pour les fiches personne et les collections (23/09/2026). Seule la réponse
// de TMDB est gardée : ce qui est dans la bibliothèque est recalculé à chaque requête.
describe("le cache d'une semaine des fiches personne et des collections", () => {
  it("ne redemande pas une filmographie, mais voit un film arrivé depuis", async () => {
    mockTmdb.getPersonDetails.mockResolvedValue({ name: "Actor", biography: "Bio" });
    mockTmdb.getPersonCredits.mockResolvedValue({
      cast: [{ id: 603, media_type: "movie", title: "Matrix", release_date: "1999-03-31", popularity: 1, vote_average: 8, poster_path: null, character: "Neo" }],
    });
    const { GET } = await import("@/app/api/tmdb/person/[id]/route");
    expect((await (await GET(fakeReq(), params("6384"))).json()).credits[0].inLibrary).toBe(false);

    mockCachedMovies.mockResolvedValue([{ id: 42, tmdbId: 603, hasFile: true }]);
    const second = await (await GET(fakeReq(), params("6384"))).json();
    expect(mockTmdb.getPersonCredits).toHaveBeenCalledTimes(1);
    expect(second.credits[0]).toMatchObject({ inLibrary: true, libraryId: 42 });
  });

  it("ne redemande pas une collection", async () => {
    mockTmdb.getCollection.mockResolvedValue({ name: "Saga", overview: "", parts: [] });
    const { GET } = await import("@/app/api/tmdb/collection/[id]/route");
    await GET(fakeReq(), params("10"));
    await GET(fakeReq(), params("10"));
    expect(mockTmdb.getCollection).toHaveBeenCalledTimes(1);
  });

  // Gardée une semaine, une coupure réseau aurait laissé l'acteur sans photos pendant sept jours.
  it("ne garde pas un échec comme une liste vide", async () => {
    mockTmdb.getPersonImages.mockRejectedValueOnce(new Error("down"));
    const { GET } = await import("@/app/api/tmdb/person/[id]/photos/route");
    expect((await (await GET(fakeReq(), params("7"))).json()).photos).toEqual([]);
    mockTmdb.getPersonImages.mockResolvedValueOnce({ profiles: [{ file_path: "/a.jpg", width: 2, height: 3, vote_average: 5 }] });
    expect((await (await GET(fakeReq(), params("7"))).json()).photos).toHaveLength(1);
  });

  it("ne garde pas une fiche enrichie quand TMDB n'a rien répondu", async () => {
    mockTmdb.getPersonImages.mockRejectedValue(new Error("down"));
    mockTmdb.getPersonExternalIds.mockRejectedValue(new Error("down"));
    mockTmdb.getPersonDetails.mockRejectedValue(new Error("down"));
    const { GET } = await import("@/app/api/tmdb/person/[id]/enriched/route");
    await GET(fakeReq(), params("8"));
    expect(persisted.size).toBe(0);
  });
});

// Une réponse partielle était gardée une semaine : une fiche sans photos parce qu'un seul des
// trois appels avait échoué ce jour-là (23/09/2026).
describe("la fiche enrichie — échecs partiels", () => {
  it("ne garde rien quand un seul appel à TMDB échoue", async () => {
    mockTmdb.getPersonImages.mockRejectedValue(new Error("429"));
    mockTmdb.getPersonExternalIds.mockResolvedValue({ imdb_id: "nm1" });
    mockTmdb.getPersonDetails.mockResolvedValue({ name: "Actor" });
    const { GET } = await import("@/app/api/tmdb/person/[id]/enriched/route");
    await GET(fakeReq(), params("9"));
    expect(persisted.size).toBe(0);
  });

  it("n'accepte pas une langue inventée dans la clé du cache", async () => {
    mockTmdb.getPersonImages.mockResolvedValue({ profiles: [] });
    mockTmdb.getPersonExternalIds.mockResolvedValue({});
    mockTmdb.getPersonDetails.mockResolvedValue({ name: "" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const { GET } = await import("@/app/api/tmdb/person/[id]/enriched/route");
    const req = { cookies: { get: () => ({ value: "zz-anything" }) } } as unknown as NextRequest;
    await GET(req, params("10"));
    expect([...persisted.keys()]).toEqual(["enriched:person:10:fr"]);
    vi.unstubAllGlobals();
  });
});
