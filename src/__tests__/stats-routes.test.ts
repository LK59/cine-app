import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockGetDiskStats = vi.fn();
vi.mock("@/lib/disk-stats", () => ({ getDiskStats: () => mockGetDiskStats() }));

const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
  withPersistentCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
}));

const mockTmdb = { isEnabled: vi.fn(() => true), getMovie: vi.fn(), getTv: vi.fn() };
vi.mock("@/lib/clients/tmdb", () => ({ tmdb: mockTmdb, TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p" }));

const mockGetStorageStats = vi.fn();
vi.mock("@/lib/storage-scan", () => ({ getStorageStats: (...args: unknown[]) => mockGetStorageStats(...args) }));

function fakeReq(params: Record<string, string> = {}): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
  mockTmdb.isEnabled.mockReturnValue(true);
});

describe("GET /api/stats", () => {
  it("returns the disk stats fields as-is", async () => {
    mockGetDiskStats.mockReturnValue({ moviesBytes: 100, tvBytes: 200, seedsBytes: 50, disk: { total: 1, used: 1, free: 0 } });
    const { GET } = await import("@/app/api/stats/route");
    const body = await (await GET()).json();
    expect(body).toEqual({ moviesBytes: 100, tvBytes: 200, seedsBytes: 50, disk: { total: 1, used: 1, free: 0 } });
  });
});

describe("GET /api/stats/library", () => {
  it("categorizes VF+VO dual-audio files as 'vfvo', not just 'vf'", async () => {
    mockCachedMovies.mockResolvedValue([
      { hasFile: true, movieFile: { mediaInfo: { audioLanguages: "fre / eng" } }, genres: [] },
    ]);
    const { GET } = await import("@/app/api/stats/library/route");
    const body = await (await GET()).json();
    expect(body.languages).toEqual({ vf: 0, vfvo: 1, vo: 0, other: 0 });
  });

  it("counts HEVC/h265 and h264 codecs separately", async () => {
    mockCachedMovies.mockResolvedValue([
      { hasFile: true, movieFile: { mediaInfo: { videoCodec: "hevc" } }, genres: [] },
      { hasFile: true, movieFile: { mediaInfo: { videoCodec: "x264" } }, genres: [] },
    ]);
    const { GET } = await import("@/app/api/stats/library/route");
    const body = await (await GET()).json();
    expect(body.codecs).toEqual({ hevc: 1, h264: 1, other: 0 });
  });

  it("aggregates genres across both movies and series", async () => {
    mockCachedMovies.mockResolvedValue([{ genres: ["Action"] }]);
    mockCachedSeries.mockResolvedValue([{ genres: ["Action", "Drama"] }]);
    const { GET } = await import("@/app/api/stats/library/route");
    const body = await (await GET()).json();
    expect(body.genres).toEqual({ Action: 2, Drama: 1 });
  });

  it("groups by decade using the release year", async () => {
    mockCachedMovies.mockResolvedValue([{ year: 1994, genres: [] }, { year: 1999, genres: [] }, { year: 2021, genres: [] }]);
    const { GET } = await import("@/app/api/stats/library/route");
    const body = await (await GET()).json();
    expect(body.decades).toEqual({ "1990s": 2, "2020s": 1 });
  });

  it("sums episode counts across all series", async () => {
    mockCachedSeries.mockResolvedValue([
      { statistics: { episodeCount: 10, episodeFileCount: 8 }, genres: [] },
      { statistics: { episodeCount: 5, episodeFileCount: 5 }, genres: [] },
    ]);
    const { GET } = await import("@/app/api/stats/library/route");
    const body = await (await GET()).json();
    expect(body.series).toEqual({ total: 2, totalEpisodes: 15, episodesWithFile: 13 });
  });
});

describe("GET /api/stats/people", () => {
  it("returns empty topActors/topDirectors immediately when TMDB is disabled", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/stats/people/route");
    const body = await (await GET(fakeReq())).json();
    expect(body).toMatchObject({ topActors: [], topDirectors: [], computing: false });
  });

  it("ranks actors by number of appearances across the library", async () => {
    mockCachedMovies.mockResolvedValue([
      { tmdbId: 1, hasFile: true },
      { tmdbId: 2, hasFile: true },
    ]);
    mockTmdb.getMovie.mockImplementation((id: number) =>
      Promise.resolve({
        credits: { cast: [{ id: 100, name: "Actor A", profile_path: null }, ...(id === 2 ? [{ id: 200, name: "Actor B", profile_path: null }] : [])] },
      })
    );
    const { GET } = await import("@/app/api/stats/people/route");
    // First call triggers the background compute; poll the (mocked, synchronous-ish) promise chain.
    await GET(fakeReq());
    await new Promise((r) => setTimeout(r, 10));
    const body = await (await GET(fakeReq())).json();
    const actorA = body.topActors.find((a: { name: string }) => a.name === "Actor A");
    expect(actorA?.count).toBe(2);
  });
});

describe("GET /api/stats/storage", () => {
  it("forwards refresh=1 as forceRefresh", async () => {
    mockGetStorageStats.mockReturnValue({});
    const { GET } = await import("@/app/api/stats/storage/route");
    await GET(fakeReq({ refresh: "1" }));
    expect(mockGetStorageStats).toHaveBeenCalledWith(true);
  });

  it("defaults forceRefresh to false", async () => {
    mockGetStorageStats.mockReturnValue({});
    const { GET } = await import("@/app/api/stats/storage/route");
    await GET(fakeReq());
    expect(mockGetStorageStats).toHaveBeenCalledWith(false);
  });
});
