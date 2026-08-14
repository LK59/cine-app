import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/session", () => ({ verifySessionFull: vi.fn() }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "en-US" }));
vi.mock("@/lib/config", () => ({ config: { tmdb: { apiKey: "key" } } }));

const mockJellyfin = { getRecentlyPlayed: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));

const mockCachedMovies = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { RECOMMENDATIONS: 3600_000 },
}));

import { verifySessionFull } from "@/lib/session";

function fakeReq(cookie?: string): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockCachedMovies.mockResolvedValue([]);
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET /api/recommendations (legacy, Jellyfin-history-seeded)", () => {
  it("returns no groups when there is no Jellyfin session (jfId)", async () => {
    vi.mocked(verifySessionFull).mockResolvedValue({ u: "louis" } as any);
    global.fetch = vi.fn();
    const { GET } = await import("@/app/api/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();
    expect(body.groups).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("seeds recommendations from getRecentlyPlayed, not an unsorted movie list", async () => {
    vi.mocked(verifySessionFull).mockResolvedValue({ u: "louis", jfId: "jf-1" } as any);
    mockJellyfin.getRecentlyPlayed.mockResolvedValue({
      Items: [{ Name: "Dune", ProviderIds: { Tmdb: "42" } }],
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ id: 99, title: "Rec", poster_path: "/p.jpg", vote_average: 7.5, release_date: "2020-01-01", overview: "x" }],
      }),
    });

    const { GET } = await import("@/app/api/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();

    expect(mockJellyfin.getRecentlyPlayed).toHaveBeenCalledWith("jf-1", "Movie", 8);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ seedTitle: "Dune", seedTmdbId: 42 });
    expect(body.groups[0].movies[0]).toMatchObject({ tmdbId: 99, title: "Rec" });
  });

  it("filters out recommendations with no poster or a vote average of 6 or below", async () => {
    vi.mocked(verifySessionFull).mockResolvedValue({ u: "louis", jfId: "jf-1" } as any);
    mockJellyfin.getRecentlyPlayed.mockResolvedValue({
      Items: [{ Name: "Dune", ProviderIds: { Tmdb: "42" } }],
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: 1, title: "No poster", poster_path: null, vote_average: 8, release_date: "2020-01-01" },
          { id: 2, title: "Low rated", poster_path: "/p.jpg", vote_average: 6, release_date: "2020-01-01" },
          { id: 3, title: "Good", poster_path: "/p.jpg", vote_average: 6.1, release_date: "2020-01-01" },
        ],
      }),
    });

    const { GET } = await import("@/app/api/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();
    expect(body.groups[0].movies).toHaveLength(1);
    expect(body.groups[0].movies[0].tmdbId).toBe(3);
  });

  it("marks recommendations already present in Radarr as in-library", async () => {
    vi.mocked(verifySessionFull).mockResolvedValue({ u: "louis", jfId: "jf-1" } as any);
    mockJellyfin.getRecentlyPlayed.mockResolvedValue({
      Items: [{ Name: "Dune", ProviderIds: { Tmdb: "42" } }],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 99, id: 5, hasFile: true }]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ id: 99, title: "Rec", poster_path: "/p.jpg", vote_average: 7, release_date: "2020-01-01" }],
      }),
    });

    const { GET } = await import("@/app/api/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();
    expect(body.groups[0].movies[0]).toMatchObject({ inLibrary: true, radarrId: 5 });
  });

  it("drops a seed group entirely when the TMDB fetch for it fails", async () => {
    vi.mocked(verifySessionFull).mockResolvedValue({ u: "louis", jfId: "jf-1" } as any);
    mockJellyfin.getRecentlyPlayed.mockResolvedValue({
      Items: [{ Name: "Dune", ProviderIds: { Tmdb: "42" } }],
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: false });

    const { GET } = await import("@/app/api/recommendations/route");
    const res = await GET(fakeReq("t"));
    const body = await res.json();
    expect(body.groups).toEqual([]);
  });
});
