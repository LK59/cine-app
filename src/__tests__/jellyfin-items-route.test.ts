import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockJellyfin = { getItemUserData: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

const mockCachedJellyfinMoviesAdmin = vi.fn();
const mockCachedJellyfinMovies = vi.fn();
const mockCachedJellyfinSeriesAdmin = vi.fn();
const mockCachedJellyfinSeries = vi.fn();
const mockFindJellyfinMovieByTmdb = vi.fn();
const mockFindJellyfinSeriesByTvdb = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedJellyfinMoviesAdmin: (...a: unknown[]) => mockCachedJellyfinMoviesAdmin(...a),
  cachedJellyfinMovies: (...a: unknown[]) => mockCachedJellyfinMovies(...a),
  cachedJellyfinSeriesAdmin: (...a: unknown[]) => mockCachedJellyfinSeriesAdmin(...a),
  cachedJellyfinSeries: (...a: unknown[]) => mockCachedJellyfinSeries(...a),
  findJellyfinMovieByTmdb: (...a: unknown[]) => mockFindJellyfinMovieByTmdb(...a),
  findJellyfinSeriesByTvdb: (...a: unknown[]) => mockFindJellyfinSeriesByTvdb(...a),
}));

function fakeReq(params: Record<string, string> = {}, cookie = "t"): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCachedJellyfinMoviesAdmin.mockResolvedValue([]);
  mockCachedJellyfinSeriesAdmin.mockResolvedValue([]);
});

describe("GET /api/jellyfin/items", () => {
  it("returns null item when nothing matches in the admin list", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    mockFindJellyfinMovieByTmdb.mockReturnValue(null);
    const { GET } = await import("@/app/api/jellyfin/items/route");
    const res = await GET(fakeReq({ type: "Movie", tmdbId: "42" }));
    const body = await res.json();
    expect(body.item).toBeNull();
  });

  it("prefers the user-scoped item (with UserData) over the admin item when found", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const adminItem = { Id: "abc", Name: "Dune" };
    const userItem = { Id: "abc", Name: "Dune", UserData: { Played: true } };
    mockFindJellyfinMovieByTmdb
      .mockReturnValueOnce(adminItem) // admin lookup
      .mockReturnValueOnce(userItem); // user lookup
    mockCachedJellyfinMovies.mockResolvedValue([userItem]);
    const { GET } = await import("@/app/api/jellyfin/items/route");
    const res = await GET(fakeReq({ type: "Movie", tmdbId: "42" }));
    const body = await res.json();
    expect(body.item).toEqual(userItem);
    expect(mockJellyfin.getItemUserData).not.toHaveBeenCalled();
  });

  it("falls back to a direct getItemUserData call when the item isn't in the user's own list (permissions)", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const adminItem = { Id: "abc", Name: "Dune" };
    mockFindJellyfinMovieByTmdb.mockReturnValueOnce(adminItem).mockReturnValueOnce(null);
    mockCachedJellyfinMovies.mockResolvedValue([]);
    mockJellyfin.getItemUserData.mockResolvedValue({ UserData: { Played: true } });
    const { GET } = await import("@/app/api/jellyfin/items/route");
    const res = await GET(fakeReq({ type: "Movie", tmdbId: "42" }));
    const body = await res.json();
    expect(mockJellyfin.getItemUserData).toHaveBeenCalledWith("jf-1", "abc");
    expect(body.item.UserData).toEqual({ Played: true });
  });

  it("looks up series by TVDB id, not TMDB, for type=Series", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    mockFindJellyfinSeriesByTvdb.mockReturnValue({ Id: "s1" });
    const { GET } = await import("@/app/api/jellyfin/items/route");
    await GET(fakeReq({ type: "Series", tvdbId: "999" }));
    expect(mockFindJellyfinSeriesByTvdb).toHaveBeenCalledWith([], 999, undefined, undefined);
    expect(mockFindJellyfinMovieByTmdb).not.toHaveBeenCalled();
  });
});
