import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockJellyfin = { getResumeItems: vi.fn(), getItemProviderIds: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
}));

function fakeReq(cookie = "t"): NextRequest {
  return { cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/jellyfin/resume", () => {
  it("returns empty items when there is no Jellyfin session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("links a resumed movie to its Radarr sheet via ProviderIds.Tmdb", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "m1", Type: "Movie", Name: "Dune", ProviderIds: { Tmdb: "42" }, RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 50 } }],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 42, id: 7 }]);

    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ cinemaHref: "/radarr/7", progress: 50 });
  });

  it("resolves an episode's series link via getItemProviderIds on the parent series, not the episode itself", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{
        Id: "e1", Type: "Episode", Name: "Pilot", SeriesId: "series-1", SeriesName: "Severance",
        ParentIndexNumber: 1, IndexNumber: 3, RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 10 },
      }],
    });
    // The episode item itself carries no ProviderIds — only its parent series does.
    mockJellyfin.getItemProviderIds.mockResolvedValue({ ProviderIds: { Tvdb: "999" } });
    mockCachedSeries.mockResolvedValue([{ tvdbId: 999, id: 22 }]);

    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();

    expect(mockJellyfin.getItemProviderIds).toHaveBeenCalledWith("jf-1", "series-1");
    expect(body.items[0]).toMatchObject({ cinemaHref: "/sonarr/22", name: "Severance", subtitle: "S01E03 · Pilot" });
  });

  it("dedupes getItemProviderIds calls for multiple episodes of the same series", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [
        { Id: "e1", Type: "Episode", Name: "Ep1", SeriesId: "series-1", SeriesName: "Show", RunTimeTicks: 1, UserData: {} },
        { Id: "e2", Type: "Episode", Name: "Ep2", SeriesId: "series-1", SeriesName: "Show", RunTimeTicks: 1, UserData: {} },
      ],
    });
    mockJellyfin.getItemProviderIds.mockResolvedValue({ ProviderIds: { Tvdb: "999" } });

    const { GET } = await import("@/app/api/jellyfin/resume/route");
    await GET(fakeReq());
    expect(mockJellyfin.getItemProviderIds).toHaveBeenCalledTimes(1);
  });

  it("caps progress at 99% even when position exceeds runtime", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "m1", Type: "Movie", Name: "X", RunTimeTicks: 100, UserData: { PlaybackPositionTicks: 500 } }],
    });
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items[0].progress).toBe(99);
  });

  it("leaves cinemaHref null when nothing in the resume item matches the library", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({
      Items: [{ Id: "m1", Type: "Movie", Name: "X", ProviderIds: { Tmdb: "1" }, RunTimeTicks: 1, UserData: {} }],
    });
    mockCachedMovies.mockResolvedValue([]);
    const { GET } = await import("@/app/api/jellyfin/resume/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.items[0].cinemaHref).toBeNull();
  });
});
