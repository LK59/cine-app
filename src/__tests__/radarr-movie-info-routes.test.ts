import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = { getMovie: vi.fn(), getQueue: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
const mockBazarr = { getMovieDetails: vi.fn() };
vi.mock("@/lib/clients/bazarr", () => ({ bazarr: mockBazarr }));
const mockOmdb = { isEnabled: vi.fn(() => false), getRating: vi.fn() };
vi.mock("@/lib/clients/omdb", () => ({ omdb: mockOmdb }));
const mockTmdb = { isEnabled: vi.fn(() => true), getMovie: vi.fn(), getMovieVideos: vi.fn(), movieRecommendations: vi.fn() };
vi.mock("@/lib/clients/tmdb", () => ({
  createTmdbClient: () => mockTmdb,
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "fr-FR" }));
const mockCachedMovies = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
}));

function fakeReq(): NextRequest {
  return { cookies: { get: () => undefined } } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockOmdb.isEnabled.mockReturnValue(false);
  mockTmdb.isEnabled.mockReturnValue(true);
  mockTmdb.getMovie.mockResolvedValue({ overview: "o", genres: [], credits: { cast: [] } });
  mockTmdb.getMovieVideos.mockResolvedValue({ results: [] });
  mockBazarr.getMovieDetails.mockResolvedValue(null);
  mockRadarr.getQueue.mockResolvedValue({ records: [] });
  mockCachedMovies.mockResolvedValue([]);
});

describe("GET /api/radarr/movies/[id]/info", () => {
  it("returns 404 when the movie doesn't exist in Radarr", async () => {
    mockRadarr.getMovie.mockRejectedValue(new Error("not found"));
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(404);
  });

  it("picks the official YouTube trailer over a non-official one", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 1, tmdbId: 42 });
    mockTmdb.getMovieVideos.mockResolvedValue({
      results: [
        { type: "Trailer", site: "YouTube", official: false, key: "unofficial" },
        { type: "Trailer", site: "YouTube", official: true, key: "official" },
      ],
    });
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.trailerKey).toBe("official");
  });

  it("falls back to a non-official trailer when no official one exists", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 1, tmdbId: 42 });
    mockTmdb.getMovieVideos.mockResolvedValue({
      results: [{ type: "Trailer", site: "YouTube", official: false, key: "unofficial" }],
    });
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.trailerKey).toBe("unofficial");
  });

  it("matches the active download to this movie by id", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 1, tmdbId: 42 });
    mockRadarr.getQueue.mockResolvedValue({
      records: [{ movieId: 1, title: "Dune", status: "downloading", size: 100, sizeleft: 50, indexer: "x" }],
    });
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.activeDownload).toMatchObject({ title: "Dune", status: "downloading" });
  });

  it("skips OMDb and TMDB calls when they are disabled/no imdbId", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 1, tmdbId: 42, imdbId: null });
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.tmdb).toBeNull();
    expect(body.imdbRating).toBeNull();
    expect(mockOmdb.getRating).not.toHaveBeenCalled();
  });
});

describe("GET /api/radarr/movies/[id]/similar", () => {
  it("returns empty items when TMDB is disabled", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/radarr/movies/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("returns 404 when the source movie doesn't exist", async () => {
    mockRadarr.getMovie.mockRejectedValue(new Error("nope"));
    const { GET } = await import("@/app/api/radarr/movies/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(404);
  });

  it("marks recommended movies already in the library as in-library, with their radarrId", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 1, tmdbId: 42 });
    mockTmdb.movieRecommendations.mockResolvedValue({
      results: [{ id: 99, title: "Rec", poster_path: "/p.jpg", vote_average: 7, release_date: "2020-01-01" }],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 99, id: 55 }]);
    const { GET } = await import("@/app/api/radarr/movies/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ tmdbId: 99, radarrId: 55, inLibrary: true });
  });

  it("filters out recommendations with no poster", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 1, tmdbId: 42 });
    mockTmdb.movieRecommendations.mockResolvedValue({
      results: [{ id: 99, title: "Rec", poster_path: null, vote_average: 7, release_date: "2020-01-01" }],
    });
    const { GET } = await import("@/app/api/radarr/movies/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });
});
