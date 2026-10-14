import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Un titre que Jellyfin a seul (DECISIONS.md §89) sort de la recherche « dans la bibliothèque », et
 * s'ouvre sur sa fiche — jamais « Demander ». Le reste de la recherche : `search-route.test.ts`.
 */
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
// Declared with a rest parameter it ignores: the factory below forwards whatever the real
// module is called with, and a mock that takes no parameters can't be handed them.
const mockCreateTmdbClient = vi.fn((..._args: unknown[]) => mockTmdbSingleton);
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

const mockMembers = vi.fn();
vi.mock("@/lib/catalogueMembers", () => ({ catalogueMembers: () => mockMembers() }));

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
  mockTmdbSingleton.getPersonCredits.mockResolvedValue({ cast: [] });
  mockTmdbSingleton.movieGenres.mockResolvedValue({ genres: [] });
  mockTmdbSingleton.tvGenres.mockResolvedValue({ genres: [] });
  mockTmdbSingleton.discover.mockResolvedValue({ results: [] });
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/search — ce que Jellyfin a seul", () => {
  it("est dans la bibliothèque, regardable, sous son identifiant réservé", async () => {
    mockMembers.mockResolvedValue({
      movies: [],
      series: [],
      jellyfinOnly: { movies: [], series: [{ id: 1_500_000_000, tmdbId: 71446, tvdbId: null, imdbId: null, item: { Id: "lcdp", Name: "La casa de papel" } }] },
    });
    mockTmdbSingleton.searchMulti.mockResolvedValue({
      results: [{ id: 71446, media_type: "tv", name: "La casa de papel", popularity: 50, vote_average: 8 }],
    });
    const { GET } = await import("@/app/api/search/route");
    const body = await (await GET(fakeReq({ q: "la casa de papel" }))).json();
    expect(body.library[0]).toMatchObject({ tmdbId: 71446, sonarrId: 1_500_000_000, inLibrary: true, available: true });
    expect(body.tmdb).toHaveLength(0);
  });

  it("s'efface devant un titre de Sonarr regardable au même TMDB", async () => {
    mockCachedSeries.mockResolvedValue([{ id: 3, tmdbId: 71446 }]);
    mockMembers.mockResolvedValue({
      movies: [],
      series: [{ id: 3, tmdbId: 71446 }],
      jellyfinOnly: { movies: [], series: [{ id: 1_500_000_000, tmdbId: 71446, tvdbId: null, imdbId: null, item: { Id: "x", Name: "x" } }] },
    });
    mockTmdbSingleton.searchMulti.mockResolvedValue({
      results: [{ id: 71446, media_type: "tv", name: "La casa de papel", popularity: 50, vote_average: 8 }],
    });
    const { GET } = await import("@/app/api/search/route");
    const body = await (await GET(fakeReq({ q: "la casa de papel" }))).json();
    expect(body.library[0]).toMatchObject({ sonarrId: 3, available: true });
  });
});
