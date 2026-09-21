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
