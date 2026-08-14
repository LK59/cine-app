import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = { getCalendar: vi.fn() };
const mockSonarr = { getCalendar: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
vi.mock("@/lib/config", () => ({ config: { tmdb: { apiKey: "key" } } }));
vi.mock("@/lib/images", () => ({ posterUrl: () => null }));
vi.mock("@/lib/server-cache", () => ({
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { SHORT: 60_000 },
}));

function fakeReq(params: Record<string, string> = {}): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(params) } } as unknown as NextRequest;
}

const originalFetch = global.fetch;
const emptyTmdbPage = { ok: true, json: async () => ({ results: [] }) };

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue(emptyTmdbPage);
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET /api/calendar", () => {
  it("excludes TMDB cinema/upcoming entries already in the Radarr library", async () => {
    mockRadarr.getCalendar.mockResolvedValue([
      { id: 1, tmdbId: 42, title: "Dune", digitalRelease: "2024-01-05", images: [] },
    ]);
    mockSonarr.getCalendar.mockResolvedValue([]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: 42, title: "Dune", release_date: "2024-01-05", poster_path: null },
          { id: 99, title: "Other", release_date: "2024-01-06", poster_path: null },
        ],
      }),
    });

    const { GET } = await import("@/app/api/calendar/route");
    const res = await GET(fakeReq());
    const body = await res.json();

    const ids = body.events.map((e: { id: string }) => e.id);
    expect(ids).toContain("radarr-1");
    expect(ids).toContain("tmdb-now_playing-99");
    expect(ids).not.toContain("tmdb-now_playing-42");
  });

  it("does not filter TMDB entries when the Radarr calendar call fails", async () => {
    mockRadarr.getCalendar.mockRejectedValue(new Error("radarr down"));
    mockSonarr.getCalendar.mockResolvedValue([]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ id: 42, title: "Dune", release_date: "2024-01-05", poster_path: null }] }),
    });

    const { GET } = await import("@/app/api/calendar/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    const ids = body.events.map((e: { id: string }) => e.id);
    expect(ids).toContain("tmdb-now_playing-42");
  });

  it("formats Sonarr episodes with zero-padded season/episode numbers", async () => {
    mockRadarr.getCalendar.mockResolvedValue([]);
    mockSonarr.getCalendar.mockResolvedValue([
      { id: 5, seriesId: 10, airDate: "2024-02-01", seasonNumber: 2, episodeNumber: 3, title: "Pilot", series: { title: "Show" } },
    ]);

    const { GET } = await import("@/app/api/calendar/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.events).toContainEqual(
      expect.objectContaining({ id: "sonarr-5", detail: "S02E03 · Pilot", type: "series" })
    );
  });

  it("skips Sonarr episodes with no air date", async () => {
    mockRadarr.getCalendar.mockResolvedValue([]);
    mockSonarr.getCalendar.mockResolvedValue([{ id: 5, seriesId: 10, airDate: null, seasonNumber: 1, episodeNumber: 1, title: "x", series: { title: "Show" } }]);

    const { GET } = await import("@/app/api/calendar/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.events).toHaveLength(0);
  });

  it("dedupes events sharing the same id and sorts by date", async () => {
    mockRadarr.getCalendar.mockResolvedValue([
      { id: 1, tmdbId: 1, title: "B", digitalRelease: "2024-03-02", images: [] },
      { id: 1, tmdbId: 1, title: "B dup", digitalRelease: "2024-03-02", images: [] },
      { id: 2, tmdbId: 2, title: "A", digitalRelease: "2024-03-01", images: [] },
    ]);
    mockSonarr.getCalendar.mockResolvedValue([]);

    const { GET } = await import("@/app/api/calendar/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(["radarr-2", "radarr-1"]);
  });
});
