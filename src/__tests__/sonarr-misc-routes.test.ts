import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockSonarr = {
  getCalendar: vi.fn(),
  getQualityProfiles: vi.fn(),
  getRootFolders: vi.fn(),
  getQueue: vi.fn(),
  grabRelease: vi.fn(),
  searchReleases: vi.fn(),
};
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({ cachedSeries: (...args: unknown[]) => mockCachedSeries(...args) }));
vi.mock("@/lib/images", () => ({ posterUrl: () => "poster.jpg" }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(params: Record<string, string> = {}, body?: unknown): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    json: async () => body ?? null,
  } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/sonarr/calendar", () => {
  it("forwards start/end query params to sonarr.getCalendar", async () => {
    mockSonarr.getCalendar.mockResolvedValue([]);
    const { GET } = await import("@/app/api/sonarr/calendar/route");
    await GET(fakeReq({ start: "2024-01-01", end: "2024-02-01" }));
    expect(mockSonarr.getCalendar).toHaveBeenCalledWith("2024-01-01", "2024-02-01");
  });
});

describe("GET /api/sonarr/meta", () => {
  it("returns 502 when Sonarr is unreachable", async () => {
    mockSonarr.getQualityProfiles.mockRejectedValue(new Error("down"));
    mockSonarr.getRootFolders.mockResolvedValue([]);
    const { GET } = await import("@/app/api/sonarr/meta/route");
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it("returns quality profiles and root folders together", async () => {
    mockSonarr.getQualityProfiles.mockResolvedValue([{ id: 1, name: "HD" }]);
    mockSonarr.getRootFolders.mockResolvedValue([{ path: "/tv" }]);
    const { GET } = await import("@/app/api/sonarr/meta/route");
    const res = await GET();
    expect(await res.json()).toEqual({ qualityProfiles: [{ id: 1, name: "HD" }], rootFolders: [{ path: "/tv" }] });
  });
});

describe("GET /api/sonarr/queue", () => {
  it("returns sonarr.getQueue()'s result as-is", async () => {
    mockSonarr.getQueue.mockResolvedValue({ records: [{ id: 1 }] });
    const { GET } = await import("@/app/api/sonarr/queue/route");
    expect(await (await GET()).json()).toEqual({ records: [{ id: 1 }] });
  });
});

describe("GET /api/sonarr/recent", () => {
  it("excludes series with no real 'added' date and sorts most-recent first, capped at 8", async () => {
    mockCachedSeries.mockResolvedValue([
      { id: 1, title: "Old", added: "0001-01-01T00:00:00Z", images: [] },
      { id: 2, title: "A", added: "2024-01-01T00:00:00Z", images: [] },
      { id: 3, title: "B", added: "2024-06-01T00:00:00Z", images: [] },
    ]);
    const { GET } = await import("@/app/api/sonarr/recent/route");
    const body = await (await GET()).json();
    expect(body.map((s: { id: number }) => s.id)).toEqual([3, 2]);
  });
});

describe("POST /api/sonarr/releases", () => {
  it("returns 400 when guid or indexerId is missing", async () => {
    const { POST } = await import("@/app/api/sonarr/releases/route");
    const res = await POST(fakeReq({}, { guid: "abc" }));
    expect(res.status).toBe(400);
  });

  it("grabs the release when both fields are present", async () => {
    mockSonarr.grabRelease.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/sonarr/releases/route");
    await POST(fakeReq({}, { guid: "abc", indexerId: 3 }));
    expect(mockSonarr.grabRelease).toHaveBeenCalledWith("abc", 3);
  });
});

describe("GET /api/sonarr/series/[id]/releases", () => {
  it("passes optional seasonNumber/episodeId through as numbers, undefined when absent", async () => {
    mockSonarr.searchReleases.mockResolvedValue([]);
    const { GET } = await import("@/app/api/sonarr/series/[id]/releases/route");
    await GET(fakeReq({ seasonNumber: "2" }), { params: Promise.resolve({ id: "7" }) });
    expect(mockSonarr.searchReleases).toHaveBeenCalledWith({ seriesId: 7, seasonNumber: 2, episodeId: undefined });
  });
});
