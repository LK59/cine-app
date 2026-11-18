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
vi.mock("@/lib/title-logo", () => ({ getTitleLogoFor: (id: number, kind: string) => mockTitleLogo(id, kind) }));

vi.mock("@/lib/clients/tmdb", async (importOriginal) => ({
  // La règle de choix de la bande-annonce reste la vraie (`pickTrailer`), commune au catalogue.
  pickTrailer: (await importOriginal<typeof import("@/lib/clients/tmdb")>()).pickTrailer,
  createTmdbClient: () => mockTmdb,
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));
vi.mock("@/lib/i18n", () => ({ getTmdbLocale: () => "fr-FR", localeOf: () => "fr" }));
// Qui demande : l'administrateur par défaut (la page de gestion lit les mêmes routes) ; un compte
// ordinaire ne reçoit pas ce que seule la gestion affiche — voir `callerManages`.
const mockSession = vi.fn(async (): Promise<{ role: string } | null> => ({ role: "admin" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: () => mockSession() }));
const mockCachedSeries = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedSeries: (...args: unknown[]) => mockCachedSeries(...args),
  withCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  withPersistentCache: async (_key: string, _ttl: number, fn: () => unknown) => fn(),
  TTL: { VERY_SHORT: 5_000 },
}));

function fakeReq(): NextRequest {
  return { cookies: { get: () => undefined } } as unknown as NextRequest;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.mockImplementation(async () => ({ role: "admin" }));
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
    mockCachedSeries.mockResolvedValue([{ id: 2, tvdbId: 7 }]);
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(404);
  });

  it("resolves the TMDB TV id from the series' TVDB id before fetching TMDB details", async () => {
    mockCachedSeries.mockResolvedValue([{ id: 1, tvdbId: 555, imdbId: null }]);
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    await GET(fakeReq(), params("1"));
    expect(mockTmdb.findTvByTvdbId).toHaveBeenCalledWith(555);
    expect(mockTmdb.getTv).toHaveBeenCalledWith(100);
  });

  it("skips TMDB detail calls entirely when the TVDB->TMDB lookup finds nothing", async () => {
    mockCachedSeries.mockResolvedValue([{ id: 1, tvdbId: 555, imdbId: null }]);
    mockTmdb.findTvByTvdbId.mockResolvedValue({ tv_results: [] });
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(mockTmdb.getTv).not.toHaveBeenCalled();
    expect(body.tmdb).toBeNull();
  });

  it("filters queue records to only this series' active downloads", async () => {
    mockCachedSeries.mockResolvedValue([{ id: 1, tvdbId: 555, imdbId: null }]);
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
  // 18/11/2026 : chaque épisode avec son chemin sur le disque et le nom de sa sortie (Bazarr), et les
  // téléchargements en cours, partaient à tout compte — 96 Ko et ~400 ms pour 108 épisodes.
  it("gives a plain account none of what only the management page shows, without asking Bazarr", async () => {
    mockSession.mockImplementation(async () => ({ role: "user" }));
    mockCachedSeries.mockResolvedValue([{ id: 1, tvdbId: 555, imdbId: null }]);
    mockBazarr.getEpisodesDetails.mockResolvedValue([{ path: "/media/tv/x.mkv", sceneName: "X.S01E01-GRP" }]);
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    const body = await (await GET(fakeReq(), params("1"))).json();
    expect(body.episodeSubtitles).toEqual([]);
    expect(body.activeDownloads).toEqual([]);
    expect(mockBazarr.getEpisodesDetails).not.toHaveBeenCalled();
  });

  // 18/11/2026 : même décision que la fiche d'un film — la liste gardée au chaud, et une panne nommée.
  it("names a Sonarr outage (502) instead of answering « not found », without asking Sonarr", async () => {
    mockCachedSeries.mockRejectedValue(new Error("sonarr ne répond pas"));
    const { GET } = await import("@/app/api/sonarr/series/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(502);
    expect(mockSonarr.getSeriesById).not.toHaveBeenCalled();
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
