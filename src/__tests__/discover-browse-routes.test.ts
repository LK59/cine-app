import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockTmdb = {
  isEnabled: vi.fn(() => true),
  trendingMovies: vi.fn(),
  movieGenres: vi.fn(),
  trendingTv: vi.fn(),
  tvGenres: vi.fn(),
  searchMovies: vi.fn(),
  searchTv: vi.fn(),
};
vi.mock("@/lib/clients/tmdb", () => ({ createTmdbClient: () => mockTmdb }));
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "en-US" }));
const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...a: unknown[]) => mockCachedMovies(...a),
  cachedSeries: (...a: unknown[]) => mockCachedSeries(...a),
}));

function fakeReq(params: Record<string, string> = {}): NextRequest {
  return {
    cookies: { get: () => undefined },
    nextUrl: { searchParams: new URLSearchParams(params) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTmdb.isEnabled.mockReturnValue(true);
  mockTmdb.movieGenres.mockResolvedValue({ genres: [] });
  mockTmdb.tvGenres.mockResolvedValue({ genres: [] });
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/discover/movies", () => {
  it("returns 503 when TMDB is disabled", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/discover/movies/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(503);
  });

  it("marks a movie in-library only when Radarr reports hasFile, not merely present", async () => {
    mockTmdb.trendingMovies.mockResolvedValue({
      results: [{ id: 1, title: "M", release_date: "2020-01-01", overview: "", poster_path: null, backdrop_path: null, vote_average: 7.34, genre_ids: [] }],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 1, id: 55, hasFile: false }]);
    const { GET } = await import("@/app/api/discover/movies/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ radarrId: 55, inLibrary: false, rating: 7.3 });
  });
});

describe("GET /api/discover/series", () => {
  it("returns 503 when TMDB is disabled", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/discover/series/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(503);
  });

  it("derives inLibrary from episodeFileCount, not just presence in Sonarr", async () => {
    mockTmdb.trendingTv.mockResolvedValue({
      results: [{ id: 1, name: "S", first_air_date: "2020-01-01", overview: "", poster_path: null, backdrop_path: null, vote_average: 8, genre_ids: [] }],
    });
    mockCachedSeries.mockResolvedValue([{ tmdbId: 1, id: 66, statistics: { episodeFileCount: 0 } }]);
    const { GET } = await import("@/app/api/discover/series/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ sonarrId: 66, inLibrary: false });
  });
});
