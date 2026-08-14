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
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "fr-FR" }));
const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...a: unknown[]) => mockCachedMovies(...a),
  cachedSeries: (...a: unknown[]) => mockCachedSeries(...a),
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { VERY_LONG: 999_999 },
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(): NextRequest {
  return { cookies: { get: () => undefined } } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
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
    mockCachedMovies.mockResolvedValue([{ tmdbId: 1, id: 55 }]);
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
    mockCachedMovies.mockResolvedValue([{ tmdbId: 2, id: 77 }]);
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
