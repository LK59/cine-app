import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockSonarr = {
  addSeries: vi.fn(),
  lookupSeries: vi.fn(),
  getSeriesById: vi.fn(),
  updateSeries: vi.fn(),
  deleteSeries: vi.fn(),
  triggerSearch: vi.fn(),
  getEpisodes: vi.fn(),
  updateEpisode: vi.fn(),
};
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
const mockJellyseerr = { getTvMedia: vi.fn(), deleteMedia: vi.fn() };
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: mockJellyseerr }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockCachedSeries = vi.fn();
const mockInvalidateLibrary = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
  invalidateLibrary: () => mockInvalidateLibrary(),
}));

function fakeReq(opts: { params?: Record<string, string>; body?: unknown } = {}): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(opts.params ?? {}) },
    cookies: { get: () => undefined },
    json: async () => opts.body ?? null,
  } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockSonarr.getSeriesById.mockResolvedValue({ id: 7, tmdbId: 99 });
  mockJellyseerr.getTvMedia.mockResolvedValue({ mediaInfo: undefined });
});

describe("GET/POST /api/sonarr/series", () => {
  it("GET returns the cached series list", async () => {
    mockCachedSeries.mockResolvedValue([{ id: 1 }]);
    const { GET } = await import("@/app/api/sonarr/series/route");
    expect(await (await GET()).json()).toEqual([{ id: 1 }]);
  });

  it("POST forwards the body to sonarr.addSeries", async () => {
    mockSonarr.addSeries.mockResolvedValue({ id: 5 });
    const { POST } = await import("@/app/api/sonarr/series/route");
    await POST(fakeReq({ body: { tmdbId: 7 } }));
    expect(mockSonarr.addSeries).toHaveBeenCalledWith({ tmdbId: 7 });
  });
});

describe("GET /api/sonarr/series/lookup", () => {
  it("defaults the term to an empty string", async () => {
    mockSonarr.lookupSeries.mockResolvedValue([]);
    const { GET } = await import("@/app/api/sonarr/series/lookup/route");
    await GET(fakeReq());
    expect(mockSonarr.lookupSeries).toHaveBeenCalledWith("");
  });
});

describe("/api/sonarr/series/[id]", () => {
  it("GET fetches the series by numeric id", async () => {
    mockSonarr.getSeriesById.mockResolvedValue({ id: 7 });
    const { GET } = await import("@/app/api/sonarr/series/[id]/route");
    await GET(fakeReq(), params("7"));
    expect(mockSonarr.getSeriesById).toHaveBeenCalledWith(7);
  });

  it("DELETE invalidates the library cache on success", async () => {
    mockSonarr.deleteSeries.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/api/sonarr/series/[id]/route");
    const res = await DELETE(fakeReq(), params("7"));
    expect((await res.json()).ok).toBe(true);
    expect(mockInvalidateLibrary).toHaveBeenCalled();
  });

  it("DELETE returns 500 without invalidating the cache when Sonarr fails", async () => {
    mockSonarr.deleteSeries.mockRejectedValue(new Error("fail"));
    const { DELETE } = await import("@/app/api/sonarr/series/[id]/route");
    const res = await DELETE(fakeReq(), params("7"));
    expect(res.status).toBe(500);
    expect(mockInvalidateLibrary).not.toHaveBeenCalled();
  });

  it("DELETE also clears the stale Jellyseerr media record for this title", async () => {
    mockSonarr.deleteSeries.mockResolvedValue(undefined);
    mockJellyseerr.getTvMedia.mockResolvedValue({ mediaInfo: { id: 654, status: 5 } });
    const { DELETE } = await import("@/app/api/sonarr/series/[id]/route");
    const res = await DELETE(fakeReq(), params("7"));
    expect(mockJellyseerr.getTvMedia).toHaveBeenCalledWith(99, undefined);
    expect(mockJellyseerr.deleteMedia).toHaveBeenCalledWith(654, undefined);
    expect((await res.json()).ok).toBe(true);
  });

  it("DELETE still succeeds even if the Jellyseerr cleanup fails", async () => {
    mockSonarr.deleteSeries.mockResolvedValue(undefined);
    mockJellyseerr.getTvMedia.mockRejectedValue(new Error("Jellyseerr down"));
    const { DELETE } = await import("@/app/api/sonarr/series/[id]/route");
    const res = await DELETE(fakeReq(), params("7"));
    expect((await res.json()).ok).toBe(true);
    expect(mockInvalidateLibrary).toHaveBeenCalled();
  });
});

describe("POST /api/sonarr/series/[id]/search", () => {
  it("returns 400 for id 0", async () => {
    const { POST } = await import("@/app/api/sonarr/series/[id]/search/route");
    const res = await POST(fakeReq(), params("0"));
    expect(res.status).toBe(400);
  });

  it("triggers a series-wide search for a valid id", async () => {
    mockSonarr.triggerSearch.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/sonarr/series/[id]/search/route");
    await POST(fakeReq(), params("7"));
    expect(mockSonarr.triggerSearch).toHaveBeenCalledWith(7, undefined);
  });

  it("triggers a season-scoped search when seasonNumber is given", async () => {
    mockSonarr.triggerSearch.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/sonarr/series/[id]/search/route");
    await POST(fakeReq({ params: { seasonNumber: "2" } }), params("7"));
    expect(mockSonarr.triggerSearch).toHaveBeenCalledWith(7, 2);
  });
});

describe("GET /api/sonarr/series/[id]/episodes", () => {
  it("fetches episodes for the given series id", async () => {
    mockSonarr.getEpisodes.mockResolvedValue([]);
    const { GET } = await import("@/app/api/sonarr/series/[id]/episodes/route");
    await GET(fakeReq(), params("7"));
    expect(mockSonarr.getEpisodes).toHaveBeenCalledWith(7);
  });
});

describe("PUT /api/sonarr/episodes/[id]", () => {
  it("forwards the id and payload to sonarr.updateEpisode", async () => {
    mockSonarr.updateEpisode.mockResolvedValue({ id: 3, monitored: true });
    const { PUT } = await import("@/app/api/sonarr/episodes/[id]/route");
    await PUT(fakeReq({ body: { monitored: true } }), params("3"));
    expect(mockSonarr.updateEpisode).toHaveBeenCalledWith(3, { monitored: true });
  });
});
