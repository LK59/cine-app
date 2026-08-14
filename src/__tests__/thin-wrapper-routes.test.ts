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

describe("GET /api/bazarr/providers", () => {
  it("returns bazarr.getProviders()'s result as-is", async () => {
    mockBazarr.getProviders.mockResolvedValue([{ name: "opensubtitles" }]);
    const { GET } = await import("@/app/api/bazarr/providers/route");
    expect(await (await GET()).json()).toEqual([{ name: "opensubtitles" }]);
  });

  it("returns 502 when Bazarr is unreachable", async () => {
    mockBazarr.getProviders.mockRejectedValue(new Error("down"));
    const { GET } = await import("@/app/api/bazarr/providers/route");
    const res = await GET();
    expect(res.status).toBe(502);
  });
});

describe("GET /api/jackett/indexers", () => {
  it("returns jackett.getIndexers()'s result as-is", async () => {
    mockJackett.getIndexers.mockResolvedValue([{ id: "yts" }]);
    const { GET } = await import("@/app/api/jackett/indexers/route");
    expect(await (await GET()).json()).toEqual([{ id: "yts" }]);
  });
});

describe("GET /api/qbittorrent/torrents", () => {
  it("returns qbittorrent.getTorrents()'s result as-is", async () => {
    mockQbittorrent.getTorrents.mockResolvedValue([{ hash: "abc" }]);
    const { GET } = await import("@/app/api/qbittorrent/torrents/route");
    expect(await (await GET()).json()).toEqual([{ hash: "abc" }]);
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
