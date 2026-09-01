import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));

let playerEnabled = true;
vi.mock("@/lib/config", () => ({
  config: {
    get player() { return { enabled: playerEnabled }; },
    jellyfin: { url: "http://jellyfin:8096", apiKey: "test-key" },
  },
}));

const mockCachedJellyfinMoviesAdmin = vi.fn();
const mockCachedJellyfinSeriesAdmin = vi.fn();
// Full replace rather than importOriginal — the real module's top-level imports pull in every
// other client (radarr/sonarr/jellyseerr/...), each destructuring its own config.* section, which
// the minimal @/lib/config mock above doesn't provide. findJellyfinMovieByTmdb/getProviderIdCI
// are reimplemented here (simple TMDB-id matching, matching the real ones' primary pass) since
// these tests only exercise that path.
vi.mock("@/lib/server-cache", () => ({
  cachedJellyfinMoviesAdmin: (...a: unknown[]) => mockCachedJellyfinMoviesAdmin(...a),
  cachedJellyfinSeriesAdmin: (...a: unknown[]) => mockCachedJellyfinSeriesAdmin(...a),
  findJellyfinMovieByTmdb: (items: { ProviderIds?: { Tmdb?: string } }[], tmdbId: number) =>
    items.find((i) => i.ProviderIds?.Tmdb === String(tmdbId)) ?? null,
  getProviderIdCI: (ids: Record<string, string> | undefined, key: string) => {
    if (!ids) return undefined;
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(ids)) if (k.toLowerCase() === lower) return v;
    return undefined;
  },
}));

const mockFetchTrickplayInfo = vi.fn();
vi.mock("@/lib/trickplay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trickplay")>();
  return { ...actual, fetchTrickplayInfo: (...a: unknown[]) => mockFetchTrickplayInfo(...a) };
});

function fakeReq(params: Record<string, string> = {}, cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    nextUrl: { searchParams: new URLSearchParams(params) },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

const movieItem = { Id: "a".repeat(32), Name: "Some Movie", ProviderIds: { Tmdb: "100" } };
const seriesItem = { Id: "b".repeat(32), Name: "Some Show", ProviderIds: { Tmdb: "200" } };

beforeEach(() => {
  vi.clearAllMocks();
  playerEnabled = true;
  mockCachedJellyfinMoviesAdmin.mockResolvedValue([movieItem]);
  mockCachedJellyfinSeriesAdmin.mockResolvedValue([seriesItem]);
});

describe("GET /api/jellyfin/trickplay/preview", () => {
  it("returns 404 when the in-app player is disabled", async () => {
    playerEnabled = false;
    const { GET } = await import("@/app/api/jellyfin/trickplay/preview/route");
    const res = await GET(fakeReq({ tmdbId: "100", mediaType: "movie" }));
    expect(res.status).toBe(404);
  });

  it("rejects a missing/invalid tmdbId or mediaType", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const { GET } = await import("@/app/api/jellyfin/trickplay/preview/route");
    expect((await GET(fakeReq({ mediaType: "movie" }))).status).toBe(400);
    expect((await GET(fakeReq({ tmdbId: "100", mediaType: "book" }))).status).toBe(400);
    expect((await GET(fakeReq({ tmdbId: "0", mediaType: "movie" }))).status).toBe(400);
  });

  it("requires an authenticated Jellyfin session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/jellyfin/trickplay/preview/route");
    const res = await GET(fakeReq({ tmdbId: "100", mediaType: "movie" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the tmdbId doesn't match any item in the library", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const { GET } = await import("@/app/api/jellyfin/trickplay/preview/route");
    const res = await GET(fakeReq({ tmdbId: "999", mediaType: "movie" }));
    expect(res.status).toBe(404);
    expect(mockFetchTrickplayInfo).not.toHaveBeenCalled();
  });

  it("returns 404 when the matched item has no trickplay data yet", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockFetchTrickplayInfo.mockResolvedValue(null);
    const { GET } = await import("@/app/api/jellyfin/trickplay/preview/route");
    const res = await GET(fakeReq({ tmdbId: "100", mediaType: "movie" }));
    expect(res.status).toBe(404);
  });

  it("matches a series by its Tmdb provider id (not Tvdb) and returns spaced preview frames", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockFetchTrickplayInfo.mockResolvedValue({
      width: 320, height: 180, tileWidth: 10, tileHeight: 10, thumbnailCount: 1080, intervalMs: 10_000,
    });
    const { GET } = await import("@/app/api/jellyfin/trickplay/preview/route");
    const res = await GET(fakeReq({ tmdbId: "200", mediaType: "series" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemId).toBe(seriesItem.Id);
    expect(body.frames[0]).toBe(0);
    expect(body.frames[1]).toBe(60); // 10min gap / 10s-per-thumbnail
    expect(mockFetchTrickplayInfo).toHaveBeenCalledWith(seriesItem.Id, "jf-1", expect.any(AbortSignal));
  });

  it("returns the movie's itemId, dimensions, and frames on success", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockFetchTrickplayInfo.mockResolvedValue({
      width: 320, height: 180, tileWidth: 10, tileHeight: 10, thumbnailCount: 500, intervalMs: 10_000,
    });
    const { GET } = await import("@/app/api/jellyfin/trickplay/preview/route");
    const res = await GET(fakeReq({ tmdbId: "100", mediaType: "movie" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ itemId: movieItem.Id, width: 320, height: 180, tileWidth: 10, tileHeight: 10 });
    expect(body.frames.length).toBeGreaterThan(0);
  });
});
