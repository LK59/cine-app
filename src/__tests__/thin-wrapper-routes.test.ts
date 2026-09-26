import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockBazarr = { getProviders: vi.fn() };
vi.mock("@/lib/clients/bazarr", () => ({ bazarr: mockBazarr }));
const mockJackett = { getIndexers: vi.fn() };
vi.mock("@/lib/clients/jackett", () => ({ jackett: mockJackett }));
const mockQbittorrent = { getTorrents: vi.fn(), getTransferInfo: vi.fn() };
vi.mock("@/lib/clients/qbittorrent", () => ({ qbittorrent: mockQbittorrent }));
const mockRadarr = { searchReleases: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

function fakeReq(): NextRequest {
  return {} as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => vi.clearAllMocks());

describe("GET /api/jackett/indexers", () => {
  it("returns jackett.getIndexers()'s result as-is", async () => {
    mockJackett.getIndexers.mockResolvedValue([{ id: "yts" }]);
    const { GET } = await import("@/app/api/jackett/indexers/route");
    expect(await (await GET()).json()).toEqual([{ id: "yts" }]);
  });
});

describe("GET /api/qbittorrent/torrents", () => {
  it("renvoie les torrents sans passkey : ni magnet, ni chemin d'annonce (26/09/2026)", async () => {
    mockQbittorrent.getTorrents.mockResolvedValue([
      {
        hash: "abc",
        name: "Film",
        tracker: "https://tracker.example/0123456789abcdef/announce",
        magnet_uri: "magnet:?xt=urn:btih:abc&tr=https%3A%2F%2Ftracker.example%2F0123456789abcdef%2Fannounce",
        save_path: "/downloads",
      },
    ]);
    const { GET } = await import("@/app/api/qbittorrent/torrents/route");
    const [torrent] = await (await GET()).json();
    expect(torrent).toMatchObject({ hash: "abc", name: "Film", tracker: "https://tracker.example/" });
    expect(torrent).not.toHaveProperty("magnet_uri");
    expect(torrent).not.toHaveProperty("save_path");
    expect(JSON.stringify(torrent)).not.toContain("0123456789abcdef");
  });
});

describe("GET /api/qbittorrent/transfer", () => {
  it("returns qbittorrent.getTransferInfo()'s result as-is", async () => {
    mockQbittorrent.getTransferInfo.mockResolvedValue({ dl_info_speed: 100 });
    const { GET } = await import("@/app/api/qbittorrent/transfer/route");
    expect(await (await GET()).json()).toEqual({ dl_info_speed: 100 });
  });
});

describe("GET /api/radarr/movies/[id]/releases", () => {
  it("forwards the numeric movie id to radarr.searchReleases", async () => {
    mockRadarr.searchReleases.mockResolvedValue([]);
    const { GET } = await import("@/app/api/radarr/movies/[id]/releases/route");
    await GET(fakeReq(), params("42"));
    expect(mockRadarr.searchReleases).toHaveBeenCalledWith(42);
  });
});
