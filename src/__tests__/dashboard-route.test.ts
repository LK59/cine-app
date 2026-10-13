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
const mockConfig = vi.hoisted(() => ({
  radarr: { apiKey: "" }, sonarr: { apiKey: "" }, bazarr: { apiKey: "" }, jackett: { apiKey: "" },
  jellyfin: { apiKey: "" }, jellyseerr: { apiKey: "" }, qbittorrent: { url: "", password: "" },
}));
vi.mock("@/lib/config", () => ({ config: mockConfig }));
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
  mockConfig.radarr.apiKey = "";
  mockConfig.sonarr.apiKey = "";
  mockConfig.qbittorrent.url = "";
  mockConfig.qbittorrent.password = "";
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

  it("ne porte plus la bannière, Reprendre ni les ajouts récents (DECISIONS.md §81)", async () => {
    // L'accueil de la gestion est un tableau de bord d'administrateur : ces rangées sont au cinéma,
    // et coûtaient ici un logo TMDB et une note IMDb par titre à chaque rafraîchissement.
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    const { GET } = await import("@/app/api/dashboard/route");
    const body = await (await GET(fakeReq())).json();
    expect(Object.keys(body).sort()).toEqual(["activity", "disk", "services", "torrents"]);
    expect(mockJellyfin.getResumeItems).not.toHaveBeenCalled();
    expect(mockCachedMovies).not.toHaveBeenCalled();
  });

  it("compte les films et les séries par le cache partagé avec le cinéma, pas par une liste à chaque passage (13/10/2026)", async () => {
    // La liste Radarr pèse 4,9 Mo et 320 ms ; cet écran se relit toutes les quinze secondes pour
    // n'en tirer qu'un nombre. L'état du service, lui, reste demandé à chaque fois.
    mockConfig.radarr.apiKey = "k";
    mockConfig.sonarr.apiKey = "k";
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
    mockRadarr.getSystemStatus.mockResolvedValue({ version: "5" });
    mockSonarr.getSystemStatus.mockResolvedValue({ version: "4" });
    mockRadarr.getMissingCount.mockResolvedValue(0);
    mockRadarr.getQueueCount.mockResolvedValue(0);
    mockSonarr.getMissingCount.mockResolvedValue(0);
    mockSonarr.getQueueCount.mockResolvedValue(0);
    mockCachedMovies.mockResolvedValue([{}, {}, {}]);
    mockCachedSeries.mockResolvedValue([{}, {}]);
    const { GET } = await import("@/app/api/dashboard/route");
    const body = await (await GET(fakeReq())).json();
    const byName = (n: string) => body.services.data.find((s: { name: string }) => s.name === n);
    expect(byName("radarr")).toMatchObject({ up: true, stats: { Films: 3 } });
    expect(byName("sonarr")).toMatchObject({ up: true, stats: { Séries: 2 } });
    expect(mockRadarr.getMovies).not.toHaveBeenCalled();
    expect(mockSonarr.getSeries).not.toHaveBeenCalled();
    expect(mockRadarr.getSystemStatus).toHaveBeenCalled();
  });

  // Un service non configuré n'est pas une panne (13/10/2026) : une installation neuve lisait
  // « 9 sur 9 hors ligne » et un encart jaune « qBittorrent indisponible ».
  it("dit « non configuré » sans rien interroger, et sépare ce cas d'une panne", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", role: "admin" });
    mockConfig.radarr.apiKey = "k";
    mockRadarr.getSystemStatus.mockRejectedValue(new Error("fetch failed"));
    const { GET } = await import("@/app/api/dashboard/route");
    const body = await (await GET(fakeReq())).json();
    const byName = (n: string) => body.services.data.find((s: { name: string }) => s.name === n);
    expect(byName("sonarr")).toMatchObject({ up: false, configured: false });
    expect(byName("qbittorrent")).toMatchObject({ up: false, configured: false });
    // Une vraie panne reste une panne.
    expect(byName("radarr").up).toBe(false);
    expect(byName("radarr").configured).toBeUndefined();
    expect(body.torrents).toMatchObject({ available: false, notConfigured: true, error: null });
    expect(mockQbittorrent.getTorrents).not.toHaveBeenCalled();
    expect(mockQbittorrent.getTransferInfo).not.toHaveBeenCalled();
    expect(mockSonarr.getHistory).not.toHaveBeenCalled();
  });

  it("ne compte pas qBittorrent configuré sans adresse, même avec un mot de passe", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    mockConfig.qbittorrent.password = "x";
    const { GET } = await import("@/app/api/dashboard/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.torrents.notConfigured).toBe(true);
    expect(mockQbittorrent.getTorrents).not.toHaveBeenCalled();
  });

  it("includes disk stats synchronously (not behind withCacheSafe)", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/dashboard/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.disk.data).toMatchObject({ computedAt: 1 });
  });

  it("envoie le genre d'un événement, pas un libellé français", async () => {
    // L'écran le traduit (`activity.*`) ; « Importé » s'affichait tel quel dans les quatre langues.
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    mockConfig.radarr.apiKey = "k";
    mockRadarr.getHistory.mockResolvedValue({
      records: [
        { id: 1, date: "2026-09-21T10:00:00Z", eventType: "downloadFolderImported", movie: { id: 3, title: "Dune" } },
        { id: 2, date: "2026-09-21T09:00:00Z", eventType: "grabbed", movie: { id: 3, title: "Dune" }, data: { indexer: "x" } },
        { id: 3, date: "2026-09-21T08:00:00Z", eventType: "unknownThing", movie: { id: 3, title: "Dune" } },
      ],
    });
    const { GET } = await import("@/app/api/dashboard/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.activity.data.map((i: { type: string }) => i.type)).toEqual(["imported", "grabbed", "unknownThing"]);
  });
});
