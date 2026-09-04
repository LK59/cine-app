import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockSonarr = { getSeriesById: vi.fn(), getQueue: vi.fn() };
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: mockSonarr }));
const mockBazarr = { getEpisodesDetails: vi.fn() };
vi.mock("@/lib/clients/bazarr", () => ({ bazarr: mockBazarr }));
const mockOmdb = { isEnabled: vi.fn(() => false), getRating: vi.fn() };
vi.mock("@/lib/clients/omdb", () => ({ omdb: mockOmdb }));
const mockTmdb = {
  isEnabled: vi.fn(() => true),
  findTvByTvdbId: vi.fn(),
  getTv: vi.fn(),
  getTvVideos: vi.fn(),
  tvRecommendations: vi.fn(),
};
// Le logo du titre est résolu par son propre module, qui a son cache et son client TMDB à
// lui — ces tests portent sur la bande-annonce, la note et la file d'attente.
const mockTitleLogo = vi.fn(async (_tmdbId: number, _kind: string) => "https://image.tmdb.org/logo.png");
vi.mock("@/lib/title-logo", () => ({ getTitleLogo: (id: number, kind: string) => mockTitleLogo(id, kind) }));

vi.mock("@/lib/clients/tmdb", () => ({
  createTmdbClient: () => mockTmdb,
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "fr-FR" }));
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
}));

function fakeReq(): NextRequest {
  return { cookies: { get: () => undefined } } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockOmdb.isEnabled.mockReturnValue(false);
  mockTmdb.isEnabled.mockReturnValue(true);
  mockTmdb.findTvByTvdbId.mockResolvedValue({ tv_results: [{ id: 100 }] });
  mockTmdb.getTv.mockResolvedValue({ overview: "o", genres: [], credits: { cast: [] } });
  mockTmdb.getTvVideos.mockResolvedValue({ results: [] });
  mockBazarr.getEpisodesDetails.mockResolvedValue([]);
  mockSonarr.getQueue.mockResolvedValue({ records: [] });
  mockCachedSeries.mockResolvedValue([]);
});

describe("GET /api/sonarr/series/[id]/info", () => {
  it("returns 404 when the series doesn't exist in Sonarr", async () => {
    mockSonarr.getSeriesById.mockRejectedValue(new Error("nope"));
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(404);
  });

  it("resolves the TMDB TV id from the series' TVDB id before fetching TMDB details", async () => {
    mockSonarr.getSeriesById.mockResolvedValue({ id: 1, tvdbId: 555, imdbId: null });
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    await GET(fakeReq(), params("1"));
    expect(mockTmdb.findTvByTvdbId).toHaveBeenCalledWith(555);
    expect(mockTmdb.getTv).toHaveBeenCalledWith(100);
  });

  it("skips TMDB detail calls entirely when the TVDB->TMDB lookup finds nothing", async () => {
    mockSonarr.getSeriesById.mockResolvedValue({ id: 1, tvdbId: 555, imdbId: null });
    mockTmdb.findTvByTvdbId.mockResolvedValue({ tv_results: [] });
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(mockTmdb.getTv).not.toHaveBeenCalled();
    expect(body.tmdb).toBeNull();
  });

  it("filters queue records to only this series' active downloads", async () => {
    mockSonarr.getSeriesById.mockResolvedValue({ id: 1, tvdbId: 555, imdbId: null });
    mockSonarr.getQueue.mockResolvedValue({
      records: [
        { seriesId: 1, episodeId: 10, title: "Ep1", status: "downloading" },
        { seriesId: 2, episodeId: 20, title: "Other series", status: "downloading" },
      ],
    });
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.activeDownloads).toHaveLength(1);
    expect(body.activeDownloads[0].episodeId).toBe(10);
  });
});

describe("GET /api/sonarr/series/[id]/similar", () => {
  it("returns empty items when TMDB is disabled", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/sonarr/series/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    expect((await res.json()).items).toEqual([]);
  });

  it("returns 404 when the series doesn't exist", async () => {
    mockSonarr.getSeriesById.mockRejectedValue(new Error("nope"));
    const { GET } = await import("@/app/api/sonarr/series/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(404);
  });

  it("returns empty items when the series has no tmdbId (uses series.tmdbId directly, not TVDB lookup)", async () => {
    mockSonarr.getSeriesById.mockResolvedValue({ id: 1, tmdbId: null });
    const { GET } = await import("@/app/api/sonarr/series/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    expect((await res.json()).items).toEqual([]);
    expect(mockTmdb.tvRecommendations).not.toHaveBeenCalled();
  });

  it("marks recommended series already in the library as in-library", async () => {
    mockSonarr.getSeriesById.mockResolvedValue({ id: 1, tmdbId: 42 });
    mockTmdb.tvRecommendations.mockResolvedValue({
      results: [{ id: 99, name: "Rec", poster_path: "/p.jpg", vote_average: 7, first_air_date: "2020-01-01" }],
    });
    mockCachedSeries.mockResolvedValue([{ tmdbId: 99, id: 55 }]);
    const { GET } = await import("@/app/api/sonarr/series/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ tmdbId: 99, sonarrId: 55, inLibrary: true });
  });
});
