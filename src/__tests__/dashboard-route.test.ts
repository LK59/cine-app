import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = { getSystemStatus: vi.fn(), getMovies: vi.fn(), getMissingCount: vi.fn(), getQueueCount: vi.fn(), getHistory: vi.fn() };
const mockSonarr = { getSystemStatus: vi.fn(), getSeries: vi.fn(), getMissingCount: vi.fn(), getQueueCount: vi.fn(), getHistory: vi.fn() };
const mockBazarr = { getWantedMovies: vi.fn(), getWantedEpisodes: vi.fn() };
const mockJackett = { getIndexers: vi.fn() };
const mockJellyfin = { getSystemInfo: vi.fn(), getLibraryCounts: vi.fn(), getSessions: vi.fn(), getResumeItems: vi.fn(), getItemProviderIds: vi.fn() };
const mockJellyseerr = { getStatus: vi.fn(), getRequests: vi.fn() };
const mockQbittorrent = { getTransferInfo: vi.fn(), getTorrents: vi.fn() };
const mockTmdb = { isEnabled: vi.fn(() => false), checkAuth: vi.fn() };
const mockOmdb = { isEnabled: vi.fn(() => false), checkKey: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
vi.mock("@/lib/clients/bazarr", () => ({ bazarr: mockBazarr }));
vi.mock("@/lib/clients/jackett", () => ({ jackett: mockJackett }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: mockJellyseerr }));
vi.mock("@/lib/clients/qbittorrent", () => ({ qbittorrent: mockQbittorrent }));
vi.mock("@/lib/clients/tmdb", () => ({ tmdb: mockTmdb }));
vi.mock("@/lib/clients/omdb", () => ({ omdb: mockOmdb }));
vi.mock("@/lib/config", () => ({
  config: {
    radarr: { apiKey: "" }, sonarr: { apiKey: "" }, bazarr: { apiKey: "" }, jackett: { apiKey: "" },
    jellyfin: { apiKey: "" }, jellyseerr: { apiKey: "" }, qbittorrent: { password: "" },
  },
}));
vi.mock("@/lib/images", () => ({ posterUrl: () => null }));
vi.mock("@/lib/disk-stats", () => ({ getDiskStats: () => ({ computedAt: 1, error: null, moviesBytes: 0, tvBytes: 0, seedsBytes: 0, disk: {} }) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockCachedMovies = vi.fn();
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...a: unknown[]) => mockCachedMovies(...a),
  cachedSeries: (...a: unknown[]) => mockCachedSeries(...a),
  withCacheSafe: async (_key: string, _ttl: number, fn: () => unknown) => {
    try {
      return { data: await fn(), available: true, error: null, updatedAt: null, stale: false };
    } catch (err) {
      return { data: null, available: false, error: err instanceof Error ? err.message : "err", updatedAt: null, stale: false };
    }
  },
  TTL: { SHORT: 1, MEDIUM: 1, VERY_SHORT: 1 },
}));

function fakeReq(cookie = "t"): NextRequest {
  return { cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRadarr.getHistory.mockResolvedValue({ records: [] });
  mockSonarr.getHistory.mockResolvedValue({ records: [] });
  mockJellyseerr.getRequests.mockResolvedValue({ results: [] });
  mockCachedMovies.mockResolvedValue([]);
  mockCachedSeries.mockResolvedValue([]);
  mockQbittorrent.getTorrents.mockResolvedValue([]);
  mockTmdb.isEnabled.mockReturnValue(false);
  mockOmdb.isEnabled.mockReturnValue(false);
});

describe("GET /api/dashboard", () => {
  it("reports radarr as down with a 'not configured' message before making any network call", async () => {
    const { GET } = await import("@/app/api/dashboard/route");
    mockVerifySessionFull.mockResolvedValue(null);
    const res = await GET(fakeReq());
    const body = await res.json();
    const radarrStatus = body.services.data.find((s: { name: string }) => s.name === "radarr");
    expect(radarrStatus).toMatchObject({ up: false });
    expect(radarrStatus.detail).toContain("RADARR_API_KEY");
    expect(mockRadarr.getSystemStatus).not.toHaveBeenCalled();
  });

  it("skips the resume section entirely for a session with no jfId", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.resume.data.items).toEqual([]);
    expect(mockJellyfin.getResumeItems).not.toHaveBeenCalled();
  });

  it("fetches the resume list for a session with a jfId", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockJellyfin.getResumeItems.mockResolvedValue({ Items: [] });
    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(mockJellyfin.getResumeItems).toHaveBeenCalledWith("jf-1");
    expect(body.resume.available).toBe(true);
  });

  it("includes disk stats synchronously (not behind withCacheSafe)", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.disk.data).toMatchObject({ computedAt: 1 });
  });
});
