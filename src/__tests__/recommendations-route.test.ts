import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({
  verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args),
}));

const mockJellyfin = {
  getRecentlyPlayed: vi.fn(),
};
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));

const mockTmdb = {
  isEnabled: vi.fn(),
  movieGenres: vi.fn(),
  tvGenres: vi.fn(),
  movieRecommendations: vi.fn(),
  tvRecommendations: vi.fn(),
};
const mockCreateTmdbClient = vi.fn(() => mockTmdb);
vi.mock("@/lib/clients/tmdb", () => ({
  createTmdbClient: (...args: unknown[]) => mockCreateTmdbClient(...args),
}));

vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "en-US" }));

const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
}));

function fakeReq(cookie?: string): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

const emptyGenres = { genres: [] };
const emptyRecs = { results: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockTmdb.isEnabled.mockReturnValue(true);
  mockTmdb.movieGenres.mockResolvedValue(emptyGenres);
  mockTmdb.tvGenres.mockResolvedValue(emptyGenres);
  mockTmdb.movieRecommendations.mockResolvedValue(emptyRecs);
  mockTmdb.tvRecommendations.mockResolvedValue(emptyRecs);
  mockJellyfin.getRecentlyPlayed.mockResolvedValue({ Items: [] });
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/discover/recommendations", () => {
  it("returns 503 when TMDB is not configured", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/discover/recommendations/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(503);
  });

  it("returns empty items when there is no jfId on the session", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { GET } = await import("@/app/api/discover/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(mockJellyfin.getRecentlyPlayed).not.toHaveBeenCalled();
  });

  it("uses getRecentlyPlayed (already sorted by DatePlayed) as the recommendation source", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getRecentlyPlayed.mockImplementation((_jfId: string, itemType: string) =>
      itemType === "Movie"
        ? Promise.resolve({ Items: [{ ProviderIds: { Tmdb: "42" } }] })
        : Promise.resolve({ Items: [] })
    );
    mockTmdb.movieRecommendations.mockResolvedValue({
      results: [{ id: 99, title: "Dune", release_date: "2021-01-01", overview: "", poster_path: null, vote_average: 8, genre_ids: [] }],
    });

    const { GET } = await import("@/app/api/discover/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();

    expect(mockTmdb.movieRecommendations).toHaveBeenCalledWith(42);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ tmdbId: 99, type: "movie" });
    expect(body.hasHistory).toBe(true);
  });

  it("excludes movies already available in Radarr (hasFile)", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getRecentlyPlayed.mockImplementation((_jfId: string, itemType: string) =>
      itemType === "Movie"
        ? Promise.resolve({ Items: [{ ProviderIds: { Tmdb: "42" } }] })
        : Promise.resolve({ Items: [] })
    );
    mockCachedMovies.mockResolvedValue([{ tmdbId: 99, hasFile: true }]);
    mockTmdb.movieRecommendations.mockResolvedValue({
      results: [{ id: 99, title: "Dune", release_date: "2021-01-01", overview: "", poster_path: null, vote_average: 8, genre_ids: [] }],
    });

    const { GET } = await import("@/app/api/discover/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });

  it("dedupes items recommended from multiple sources and sorts by rating", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getRecentlyPlayed.mockImplementation((_jfId: string, itemType: string) =>
      itemType === "Movie"
        ? Promise.resolve({ Items: [{ ProviderIds: { Tmdb: "1" } }, { ProviderIds: { Tmdb: "2" } }] })
        : Promise.resolve({ Items: [] })
    );
    mockTmdb.movieRecommendations.mockImplementation((id: number) =>
      Promise.resolve({
        results: [
          { id: 100, title: "Low", release_date: "2020-01-01", overview: "", poster_path: null, vote_average: 5, genre_ids: [] },
          ...(id === 2
            ? [{ id: 100, title: "Low dup", release_date: "2020-01-01", overview: "", poster_path: null, vote_average: 5, genre_ids: [] },
               { id: 200, title: "High", release_date: "2020-01-01", overview: "", poster_path: null, vote_average: 9, genre_ids: [] }]
            : []),
        ],
      })
    );

    const { GET } = await import("@/app/api/discover/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();
    expect(body.items.map((i: { tmdbId: number }) => i.tmdbId)).toEqual([200, 100]);
  });
});
