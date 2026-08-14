import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = { getHistory: vi.fn(), getMovieHistory: vi.fn() };
const mockSonarr = { getHistory: vi.fn(), getSeriesHistory: vi.fn() };
const mockJellyseerr = { getRequests: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: mockJellyseerr }));
vi.mock("@/lib/images", () => ({ posterUrl: () => null }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: vi.fn().mockResolvedValue(null) }));
const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { MEDIUM: 3600_000 },
}));

function fakeReq(params: Record<string, string> = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRadarr.getHistory.mockResolvedValue({ records: [] });
  mockSonarr.getHistory.mockResolvedValue({ records: [] });
  mockJellyseerr.getRequests.mockResolvedValue({ results: [] });
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/timeline/global", () => {
  it("merges radarr/sonarr/jellyseerr events and sorts most-recent first", async () => {
    mockRadarr.getHistory.mockResolvedValue({
      records: [{ id: 1, date: "2024-01-01T00:00:00Z", eventType: "grabbed", sourceTitle: "Old" }],
    });
    mockSonarr.getHistory.mockResolvedValue({
      records: [{ id: 2, date: "2024-06-01T00:00:00Z", eventType: "downloadFolderImported", sourceTitle: "New" }],
    });
    const { GET } = await import("@/app/api/timeline/global/route");
    const res = await GET();
    const body = await res.json();
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(["sonarr-2", "radarr-1"]);
  });

  it("falls back to a generic 'info' entry for an unrecognized event type", async () => {
    mockRadarr.getHistory.mockResolvedValue({
      records: [{ id: 1, date: "2024-01-01T00:00:00Z", eventType: "someUnknownEvent", sourceTitle: "X" }],
    });
    const { GET } = await import("@/app/api/timeline/global/route");
    const res = await GET();
    const body = await res.json();
    expect(body.events[0]).toMatchObject({ icon: "info", severity: "info", eventType: "someUnknownEvent" });
  });

  it("caps the merged timeline at 60 entries", async () => {
    mockRadarr.getHistory.mockResolvedValue({
      records: Array.from({ length: 80 }, (_, i) => ({ id: i, date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, eventType: "grabbed", sourceTitle: `M${i}` })),
    });
    const { GET } = await import("@/app/api/timeline/global/route");
    const res = await GET();
    const body = await res.json();
    expect(body.events).toHaveLength(60);
  });
});

describe("GET /api/timeline/imports", () => {
  it("excludes deletion/failure events, keeping only grab/import", async () => {
    mockRadarr.getHistory.mockResolvedValue({
      records: [
        { id: 1, date: "2024-01-01T00:00:00Z", eventType: "grabbed", sourceTitle: "A" },
        { id: 2, date: "2024-01-02T00:00:00Z", eventType: "movieFileDeleted", sourceTitle: "B" },
      ],
    });
    const { GET } = await import("@/app/api/timeline/imports/route");
    const res = await GET();
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe("radarr-1");
  });

  it("classifies a non-grabbed kept event as an import, grabbed as a grab", async () => {
    mockRadarr.getHistory.mockResolvedValue({
      records: [
        { id: 1, date: "2024-01-01T00:00:00Z", eventType: "grabbed", sourceTitle: "A" },
        { id: 2, date: "2024-01-02T00:00:00Z", eventType: "movieFolderImported", sourceTitle: "A" },
      ],
    });
    const { GET } = await import("@/app/api/timeline/imports/route");
    const res = await GET();
    const body = await res.json();
    const grab = body.events.find((e: { id: string }) => e.id === "radarr-1");
    const imported = body.events.find((e: { id: string }) => e.id === "radarr-2");
    expect(grab.eventKind).toBe("grab");
    expect(imported.eventKind).toBe("import");
  });

  it("formats series episode detail with season/episode and title", async () => {
    mockSonarr.getHistory.mockResolvedValue({
      records: [{
        id: 1, date: "2024-01-01T00:00:00Z", eventType: "downloadFolderImported",
        series: { id: 5, title: "Show" }, episode: { seasonNumber: 2, episodeNumber: 3, title: "Pilot" },
      }],
    });
    const { GET } = await import("@/app/api/timeline/imports/route");
    const res = await GET();
    const body = await res.json();
    expect(body.events[0].detail).toBe("S02E03 · Pilot");
  });
});

describe("GET /api/timeline/media", () => {
  it("returns empty events when mediaType is missing", async () => {
    const { GET } = await import("@/app/api/timeline/media/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.events).toEqual([]);
    expect(mockRadarr.getMovieHistory).not.toHaveBeenCalled();
  });

  it("returns empty events when neither radarrId nor sonarrId is given", async () => {
    const { GET } = await import("@/app/api/timeline/media/route");
    const res = await GET(fakeReq({ type: "movie" }));
    const body = await res.json();
    expect(body.events).toEqual([]);
  });

  it("fetches per-movie history for a movie with a radarrId", async () => {
    mockRadarr.getMovieHistory.mockResolvedValue([
      { id: 1, date: "2024-01-01T00:00:00Z", eventType: "grabbed", data: { indexer: "IndexerX" } },
    ]);
    const { GET } = await import("@/app/api/timeline/media/route");
    const res = await GET(fakeReq({ type: "movie", radarrId: "42" }));
    const body = await res.json();
    expect(mockRadarr.getMovieHistory).toHaveBeenCalledWith(42);
    expect(body.events[0].detail).toBe("IndexerX");
  });

  it("only includes jellyseerr requests matching both tmdbId and media type", async () => {
    mockRadarr.getMovieHistory.mockResolvedValue([]);
    mockJellyseerr.getRequests.mockResolvedValue({
      results: [
        { id: 1, status: 1, createdAt: "2024-01-01T00:00:00Z", type: "movie", media: { tmdbId: 42 } },
        { id: 2, status: 1, createdAt: "2024-01-01T00:00:00Z", type: "tv", media: { tmdbId: 42 } },
        { id: 3, status: 1, createdAt: "2024-01-01T00:00:00Z", type: "movie", media: { tmdbId: 999 } },
      ],
    });
    const { GET } = await import("@/app/api/timeline/media/route");
    const res = await GET(fakeReq({ type: "movie", radarrId: "42", tmdbId: "42" }));
    const body = await res.json();
    expect(body.events.filter((e: { source: string }) => e.source === "jellyseerr")).toHaveLength(1);
  });
});
