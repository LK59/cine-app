import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = {
  getCalendar: vi.fn(),
  getQualityProfiles: vi.fn(),
  getRootFolders: vi.fn(),
  getQueue: vi.fn(),
  grabRelease: vi.fn(),
};
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
const mockCachedMovies = vi.fn();
vi.mock("@/lib/server-cache", () => ({ cachedMovies: (...args: unknown[]) => mockCachedMovies(...args) }));
vi.mock("@/lib/images", () => ({ posterUrl: () => "poster.jpg" }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(params: Record<string, string> = {}, body?: unknown): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(params) },
    json: async () => body ?? null,
  } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/radarr/calendar", () => {
  it("forwards start/end query params to radarr.getCalendar", async () => {
    mockRadarr.getCalendar.mockResolvedValue([]);
    const { GET } = await import("@/app/api/radarr/calendar/route");
    await GET(fakeReq({ start: "2024-01-01", end: "2024-02-01" }));
    expect(mockRadarr.getCalendar).toHaveBeenCalledWith("2024-01-01", "2024-02-01");
  });
});

describe("GET /api/radarr/meta", () => {
  it("returns quality profiles and root folders together", async () => {
    mockRadarr.getQualityProfiles.mockResolvedValue([{ id: 1, name: "HD" }]);
    mockRadarr.getRootFolders.mockResolvedValue([{ path: "/movies" }]);
    const { GET } = await import("@/app/api/radarr/meta/route");
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ qualityProfiles: [{ id: 1, name: "HD" }], rootFolders: [{ path: "/movies" }] });
  });

  it("returns 502 when Radarr is unreachable", async () => {
    mockRadarr.getQualityProfiles.mockRejectedValue(new Error("down"));
    mockRadarr.getRootFolders.mockResolvedValue([]);
    const { GET } = await import("@/app/api/radarr/meta/route");
    const res = await GET();
    expect(res.status).toBe(502);
  });
});

describe("GET /api/radarr/queue", () => {
  it("returns radarr.getQueue()'s result as-is", async () => {
    mockRadarr.getQueue.mockResolvedValue({ records: [{ id: 1 }] });
    const { GET } = await import("@/app/api/radarr/queue/route");
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ records: [{ id: 1 }] });
  });
});

describe("POST /api/radarr/releases", () => {
  it("returns 400 when guid or indexerId is missing", async () => {
    const { POST } = await import("@/app/api/radarr/releases/route");
    const res = await POST(fakeReq({}, { guid: "abc" }));
    expect(res.status).toBe(400);
  });

  it("grabs the release when both fields are present", async () => {
    mockRadarr.grabRelease.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/radarr/releases/route");
    const res = await POST(fakeReq({}, { guid: "abc", indexerId: 3 }));
    expect(res.status).toBe(200);
    expect(mockRadarr.grabRelease).toHaveBeenCalledWith("abc", 3);
  });
});
