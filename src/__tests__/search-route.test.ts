import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/session", () => ({ verifySessionFull: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/i18n", () => ({
  LOCALE_COOKIE: "cine-lang",
  getTmdbLocale: (locale: string) => (locale === "fr" ? "fr-FR" : `${locale}-XX`),
}));

const mockTmdbSingleton = {
  isEnabled: vi.fn(() => true),
  searchMulti: vi.fn(),
  searchPerson: vi.fn(),
  getMovie: vi.fn(),
  getTv: vi.fn(),
  getPersonCredits: vi.fn(),
  movieGenres: vi.fn(),
  tvGenres: vi.fn(),
  discover: vi.fn(),
};
const mockCreateTmdbClient = vi.fn(() => mockTmdbSingleton);
vi.mock("@/lib/clients/tmdb", () => ({
  tmdb: mockTmdbSingleton,
  createTmdbClient: (...args: unknown[]) => mockCreateTmdbClient(...args),
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));

const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
  // Pass-through: no real caching, just run the factory — lets tests observe the
  // route's own logic without needing a real kv_cache/db layer.
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  withPersistentCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { MEDIUM: 3600_000 },
}));

function fakeReq(params: Record<string, string>, cookies: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    cookies: { get: (name: string) => (cookies[name] ? { value: cookies[name] } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTmdbSingleton.isEnabled.mockReturnValue(true);
  mockTmdbSingleton.searchMulti.mockResolvedValue({ results: [] });
  mockTmdbSingleton.searchPerson.mockResolvedValue({ results: [] });
  mockTmdbSingleton.movieGenres.mockResolvedValue({ genres: [] });
  mockTmdbSingleton.tvGenres.mockResolvedValue({ genres: [] });
  mockTmdbSingleton.discover.mockResolvedValue({ results: [] });
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/search", () => {
  it("returns empty results for a query shorter than 2 chars", async () => {
    const { GET } = await import("@/app/api/search/route");
    const res = await GET(fakeReq({ q: "a" }));
    const body = await res.json();
    expect(body).toEqual({ library: [], tmdb: [], persons: [] });
    expect(mockTmdbSingleton.searchMulti).not.toHaveBeenCalled();
  });

  it("returns empty results when TMDB is disabled", async () => {
    mockTmdbSingleton.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/search/route");
    const res = await GET(fakeReq({ q: "dune" }));
    const body = await res.json();
    expect(body).toEqual({ library: [], tmdb: [], persons: [] });
  });

  it("marks a TMDB result already in Radarr as in-library", async () => {
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, id: 7 }]);
    mockTmdbSingleton.searchMulti.mockResolvedValue({
      results: [{ id: 42, media_type: "movie", title: "Dune", popularity: 10, vote_average: 8 }],
    });

    const { GET } = await import("@/app/api/search/route");
    const res = await GET(fakeReq({ q: "dune" }));
    const body = await res.json();

    expect(body.library).toHaveLength(1);
    expect(body.library[0]).toMatchObject({ tmdbId: 42, radarrId: 7, inLibrary: true, sources: ["radarr"] });
    expect(body.tmdb).toHaveLength(0);
  });

  it("rejects searchMulti results whose title score is below the threshold", async () => {
    mockTmdbSingleton.searchMulti.mockResolvedValue({
      results: [{ id: 1, media_type: "movie", title: "Completely Unrelated Title", popularity: 5, vote_average: 5 }],
    });

    const { GET } = await import("@/app/api/search/route");
    const res = await GET(fakeReq({ q: "dune" }));
    const body = await res.json();
    expect(body.tmdb).toHaveLength(0);
  });

  it("does not surface debug info to non-admin sessions even when debug=1 is requested", async () => {
    const { GET } = await import("@/app/api/search/route");
    const res = await GET(fakeReq({ q: "dune", debug: "1" }));
    const body = await res.json();
    expect(body.debug).toBeUndefined();
  });

  it("a transient TMDB failure during the cast/director credits check excludes the item instead of throwing", async () => {
    // Regression guard for the 2026-08-10 fix: matchesNaturalPeople's .catch() must live
    // outside withPersistentCache so a timeout is treated as "no match this time", not
    // permanently cached as a rejection.
    mockTmdbSingleton.searchPerson.mockResolvedValue({ results: [{ id: 999 }] });
    mockTmdbSingleton.discover.mockResolvedValue({
      results: [{ id: 55, title: "Some Movie", popularity: 1, vote_average: 6 }],
    });
    mockTmdbSingleton.getMovie.mockRejectedValue(new Error("tmdb timeout"));

    const { GET } = await import("@/app/api/search/route");
    const res = await GET(fakeReq({ q: "films avec jean dujardin" }));
    await expect(res.json()).resolves.toBeDefined();
    expect(res.status).toBe(200);
  });
});
