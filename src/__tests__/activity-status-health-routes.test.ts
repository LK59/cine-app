import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = { getHistory: vi.fn(), getSystemStatus: vi.fn(), getMovies: vi.fn(), getMissingCount: vi.fn(), getQueueCount: vi.fn() };
const mockSonarr = { getHistory: vi.fn(), getSystemStatus: vi.fn(), getSeries: vi.fn(), getMissingCount: vi.fn(), getQueueCount: vi.fn() };
const mockJellyseerr = { getRequests: vi.fn(), getRequestsByUser: vi.fn(), getMe: vi.fn(), getStatus: vi.fn() };
const mockBazarr = { getWantedMovies: vi.fn(), getWantedEpisodes: vi.fn() };
const mockJackett = { getIndexers: vi.fn() };
const mockJellyfin = { getSystemInfo: vi.fn(), getLibraryCounts: vi.fn(), getSessions: vi.fn() };
const mockQbittorrent = { getTransferInfo: vi.fn(), getTorrents: vi.fn() };
const mockTmdb = { isEnabled: vi.fn(() => true), checkAuth: vi.fn() };
const mockOmdb = { isEnabled: vi.fn(() => true), checkKey: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: mockJellyseerr }));
vi.mock("@/lib/clients/bazarr", () => ({ bazarr: mockBazarr }));
vi.mock("@/lib/clients/jackett", () => ({ jackett: mockJackett }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/clients/qbittorrent", () => ({ qbittorrent: mockQbittorrent }));
vi.mock("@/lib/clients/tmdb", () => ({ tmdb: mockTmdb }));
vi.mock("@/lib/clients/omdb", () => ({ omdb: mockOmdb }));
vi.mock("@/lib/config", () => ({
  config: {
    jellyfin: { url: "http://jf.local" },
    jellyseerr: { url: "http://js.local" },
    radarr: { url: "http://radarr.local", apiKey: "k" },
    sonarr: { url: "http://sonarr.local", apiKey: "k" },
    bazarr: { url: "http://bazarr.local", apiKey: "k" },
    jackett: { url: "http://jackett.local" },
    qbittorrent: { url: "http://qbit.local" },
  },
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
// Point storage-path checks at a directory guaranteed to exist in any environment, so
// GET /api/health's "overall" status in these tests reflects only the mocked services
// below, not whether /mnt/media/video happens to be mounted on the machine running tests.
vi.mock("@/lib/media-paths", () => ({
  MEDIA_ROOT: "/tmp",
  MOVIES_PATH: "/tmp",
  TV_PATH: "/tmp",
  SEEDS_PATH: "/tmp",
  SEED_MOVIES_PATH: "/tmp",
  SEED_TV_PATH: "/tmp",
  CROSS_SEED_PATH: "/tmp",
}));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));

function fakeReq(): NextRequest {
  return { cookies: { get: () => undefined } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRadarr.getHistory.mockResolvedValue({ records: [] });
  mockSonarr.getHistory.mockResolvedValue({ records: [] });
  mockJellyseerr.getRequests.mockResolvedValue({ results: [] });
  // Admin by default — the pre-existing tests below care about the general shape of the
  // response, not the admin/self scoping (covered separately in jellyseerr-scope.test.ts),
  // and admin is the branch that matches their original (pre-scoping) getRequests-based mocks.
  mockVerifySessionFull.mockResolvedValue({ role: "admin" });
});

describe("GET /api/activity", () => {
  it("merges and sorts radarr/sonarr/jellyseerr activity, capped at 25", async () => {
    mockRadarr.getHistory.mockResolvedValue({
      records: [{ id: 1, date: "2024-01-01T00:00:00Z", eventType: "grabbed", sourceTitle: "Old" }],
    });
    mockSonarr.getHistory.mockResolvedValue({
      records: [{ id: 2, date: "2024-06-01T00:00:00Z", eventType: "downloadFolderImported", sourceTitle: "New" }],
    });
    const { GET } = await import("@/app/api/activity/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.map((i: { id: string }) => i.id)).toEqual(["sonarr-2", "radarr-1"]);
  });
});

describe("GET /api/status", () => {
  it("reports a service down with the error message when its probe throws", async () => {
    mockRadarr.getSystemStatus.mockRejectedValue(new Error("ECONNREFUSED"));
    mockRadarr.getMovies.mockResolvedValue([]);
    mockRadarr.getMissingCount.mockResolvedValue(0);
    mockRadarr.getQueueCount.mockResolvedValue(0);
    mockSonarr.getSystemStatus.mockResolvedValue({ version: "1" });
    mockSonarr.getSeries.mockResolvedValue([]);
    mockSonarr.getMissingCount.mockResolvedValue(0);
    mockSonarr.getQueueCount.mockResolvedValue(0);
    mockBazarr.getWantedMovies.mockResolvedValue({ total: 0 });
    mockBazarr.getWantedEpisodes.mockResolvedValue({ total: 0 });
    mockJackett.getIndexers.mockResolvedValue([]);
    mockJellyfin.getSystemInfo.mockResolvedValue({ Version: "1" });
    mockJellyfin.getLibraryCounts.mockResolvedValue({ MovieCount: 0, SeriesCount: 0 });
    mockJellyfin.getSessions.mockResolvedValue([]);
    mockJellyseerr.getStatus.mockResolvedValue({ version: "1" });
    mockJellyseerr.getRequests.mockResolvedValue({ results: [], pageInfo: { results: 0 } });
    mockQbittorrent.getTransferInfo.mockResolvedValue({ dl_info_speed: 0, up_info_speed: 0 });
    mockQbittorrent.getTorrents.mockResolvedValue([]);
    mockTmdb.checkAuth.mockResolvedValue({ success: true });
    mockOmdb.checkKey.mockResolvedValue({ Response: "True" });

    const { GET } = await import("@/app/api/status/route");
    const body = await (await GET(fakeReq())).json();
    const radarrStatus = body.find((s: { name: string }) => s.name === "radarr");
    expect(radarrStatus).toMatchObject({ up: false, detail: "ECONNREFUSED" });
  });

  it("reports tmdb down with a specific message when the API key is missing", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    mockRadarr.getSystemStatus.mockResolvedValue({ version: "1" });
    mockRadarr.getMovies.mockResolvedValue([]);
    mockRadarr.getMissingCount.mockResolvedValue(0);
    mockRadarr.getQueueCount.mockResolvedValue(0);
    mockSonarr.getSystemStatus.mockResolvedValue({ version: "1" });
    mockSonarr.getSeries.mockResolvedValue([]);
    mockSonarr.getMissingCount.mockResolvedValue(0);
    mockSonarr.getQueueCount.mockResolvedValue(0);
    mockBazarr.getWantedMovies.mockResolvedValue({ total: 0 });
    mockBazarr.getWantedEpisodes.mockResolvedValue({ total: 0 });
    mockJackett.getIndexers.mockResolvedValue([]);
    mockJellyfin.getSystemInfo.mockResolvedValue({ Version: "1" });
    mockJellyfin.getLibraryCounts.mockResolvedValue({ MovieCount: 0, SeriesCount: 0 });
    mockJellyfin.getSessions.mockResolvedValue([]);
    mockJellyseerr.getStatus.mockResolvedValue({ version: "1" });
    mockJellyseerr.getRequests.mockResolvedValue({ results: [], pageInfo: { results: 0 } });
    mockQbittorrent.getTransferInfo.mockResolvedValue({ dl_info_speed: 0, up_info_speed: 0 });
    mockQbittorrent.getTorrents.mockResolvedValue([]);
    mockOmdb.checkKey.mockResolvedValue({ Response: "True" });

    const { GET } = await import("@/app/api/status/route");
    const body = await (await GET(fakeReq())).json();
    const tmdbStatus = body.find((s: { name: string }) => s.name === "tmdb");
    expect(tmdbStatus).toMatchObject({ up: false, detail: "Clé API non configurée (TMDB_API_KEY)" });
  });
});

describe("GET /api/health", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it("reports overall 'ok' when every service responds fine", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ Version: "1", version: "1" }) });
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    expect(body.overall).toBe("ok");
    expect(body.services).toHaveLength(7);
  });

  it("reports overall 'down' when at least one service is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    expect(body.overall).toBe("down");
    expect(body.services.every((s: { status: string }) => s.status === "down")).toBe(true);
  });

  it("reports 'degraded' overall when some services are ok and none are fully down", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    expect(body.overall).toBe("degraded");
  });
});
