import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Un service non configuré n'est jamais interrogé (13/10/2026). Une installation neuve sans
 * qBittorrent appelait l'adresse par défaut (`http://gluetun:8080`) toutes les quinze secondes pour
 * le suivi des torrents : une erreur dans `server.log` à chaque passage, et un risque de
 * bannissement d'adresse par qBittorrent (cinq connexions refusées, une heure). Le contrôle d'état,
 * lui, appelait chaque minute les adresses par défaut de tout ce qui n'était pas branché.
 */
const mockConfig = vi.hoisted(() => ({
  app: { language: "en" },
  radarr: { url: "http://radarr:7878", apiKey: "" },
  sonarr: { url: "http://sonarr:8989", apiKey: "" },
  bazarr: { url: "http://bazarr:6767", apiKey: "" },
  jackett: { url: "http://jackett:9117", apiKey: "" },
  jellyfin: { url: "http://jellyfin:8096", apiKey: "", publicUrl: "" },
  jellyseerr: { url: "http://jellyseerr:5055", apiKey: "" },
  qbittorrent: { url: "", username: "admin", password: "" },
  tmdb: { apiKey: "" },
  omdb: { apiKey: "" },
  mdblist: { apiKey: "" },
}));
vi.mock("@/lib/config", () => ({ config: mockConfig }));
const mockCachedTorrents = vi.fn(async () => []);
vi.mock("@/lib/server-cache", () => ({ cachedTorrents: () => mockCachedTorrents() }));
const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLogError(...a) }));
vi.mock("@/lib/push", () => ({ sendPushToAdmins: vi.fn() }));

const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchSpy);
  mockConfig.qbittorrent.url = "";
  mockConfig.qbittorrent.password = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("qBittorrent non configuré", () => {
  it("le client refuse avant tout réseau, avec une erreur « non configuré »", async () => {
    const { qbittorrent } = await import("@/lib/clients/qbittorrent");
    const { ServiceNotConfiguredError } = await import("@/lib/serviceConfigured");
    await expect(qbittorrent.getTorrents()).rejects.toBeInstanceOf(ServiceNotConfiguredError);
    // Un mot de passe sans adresse ne suffit pas : l'adresse n'a plus de défaut.
    mockConfig.qbittorrent.password = "x";
    await expect(qbittorrent.getTransferInfo()).rejects.toBeInstanceOf(ServiceNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("le suivi des torrents ne demande rien et n'écrit rien au journal", async () => {
    const { pollTorrentWatch, createTorrentWatchState, createTorrentDigest } = await import("@/lib/torrentWatch");
    await pollTorrentWatch(createTorrentWatchState(), createTorrentDigest());
    expect(mockCachedTorrents).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
    // Branché dans l'application : le passage suivant le lit, sans redémarrage.
    mockConfig.qbittorrent.url = "http://qb:8080";
    mockConfig.qbittorrent.password = "x";
    await pollTorrentWatch(createTorrentWatchState(), createTorrentDigest());
    expect(mockCachedTorrents).toHaveBeenCalledTimes(1);
  });

  it("le contrôle d'état n'appelle aucun service non configuré, et le dit", async () => {
    const { runAllServiceChecks } = await import("@/lib/healthChecks");
    const result = await runAllServiceChecks();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.qbittorrent.status).toBe("down");
    expect(result.qbittorrent.error).toMatch(/^Non configuré/);
    expect(result.radarr.error).toMatch(/^Non configuré/);
  });
});
