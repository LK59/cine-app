import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockTmdbFr = {
  isEnabled: vi.fn(() => true),
  searchMovies: vi.fn(),
  searchTv: vi.fn(),
  movieGenres: vi.fn(),
  tvGenres: vi.fn(),
};
const mockTmdbEn = {
  isEnabled: vi.fn(() => true),
  searchMovies: vi.fn(),
  searchTv: vi.fn(),
  movieGenres: vi.fn(),
  tvGenres: vi.fn(),
};
vi.mock("@/lib/clients/tmdb", () => ({
  createTmdbClient: (locale: string) => (locale === "en-US" ? mockTmdbEn : mockTmdbFr),
}));
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "fr-FR" }));
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
  mockTmdbFr.isEnabled.mockReturnValue(true);
  mockTmdbFr.movieGenres.mockResolvedValue({ genres: [] });
  mockTmdbFr.tvGenres.mockResolvedValue({ genres: [] });
  mockTmdbFr.searchMovies.mockResolvedValue({ results: [] });
  mockTmdbFr.searchTv.mockResolvedValue({ results: [] });
  mockTmdbEn.searchMovies.mockResolvedValue({ results: [] });
  mockTmdbEn.searchTv.mockResolvedValue({ results: [] });
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/discover/search", () => {
  it("returns empty items for a query shorter than 2 chars", async () => {
    const { GET } = await import("@/app/api/discover/search/route");
    const res = await GET(fakeReq({ q: "a" }));
    expect((await res.json()).items).toEqual([]);
    expect(mockTmdbFr.searchMovies).not.toHaveBeenCalled();
  });

  it("returns 503 when TMDB is disabled", async () => {
    mockTmdbFr.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/discover/search/route");
    const res = await GET(fakeReq({ q: "dune" }));
    expect(res.status).toBe(503);
  });

  it("merges French and English search results without duplicating a movie present in both", async () => {
    mockTmdbFr.searchMovies.mockResolvedValue({
      results: [{ id: 1, title: "La Chasse", original_title: "The Hunt", release_date: "2020-01-01", overview: "", poster_path: null, vote_average: 7, popularity: 5, genre_ids: [] }],
    });
    mockTmdbEn.searchMovies.mockResolvedValue({
      results: [{ id: 1, title: "The Hunt", original_title: "The Hunt", release_date: "2020-01-01", overview: "", poster_path: null, vote_average: 7, popularity: 5, genre_ids: [] }],
    });
    const { GET } = await import("@/app/api/discover/search/route");
    const res = await GET(fakeReq({ q: "hunt" }));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
  });

  it("marks a movie in-library based on Radarr's hasFile", async () => {
    mockTmdbFr.searchMovies.mockResolvedValue({
      results: [{ id: 1, title: "Dune", original_title: "Dune", release_date: "2020-01-01", overview: "", poster_path: null, vote_average: 7, popularity: 5, genre_ids: [] }],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 1, id: 88, hasFile: true }]);
    const { GET } = await import("@/app/api/discover/search/route");
    const res = await GET(fakeReq({ q: "dune" }));
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ radarrId: 88, inLibrary: true });
  });

  it("searches TV instead of movies when type=series", async () => {
    mockTmdbFr.searchTv.mockResolvedValue({
      results: [{ id: 2, name: "Show", original_name: "Show", first_air_date: "2020-01-01", overview: "", poster_path: null, vote_average: 8, popularity: 5, genre_ids: [] }],
    });
    const { GET } = await import("@/app/api/discover/search/route");
    const res = await GET(fakeReq({ q: "show", type: "series" }));
    const body = await res.json();
    expect(mockTmdbFr.searchMovies).not.toHaveBeenCalled();
    expect(body.items[0].title).toBe("Show");
  });
});
