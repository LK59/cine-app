import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockRadarr = { getMovie: vi.fn(), getQueue: vi.fn() };
vi.mock("@/lib/clients/radarr", () => ({ radarr: mockRadarr }));
const mockBazarr = { getMovieDetails: vi.fn() };
vi.mock("@/lib/clients/bazarr", () => ({ bazarr: mockBazarr }));
const mockOmdb = { isEnabled: vi.fn(() => false), getRating: vi.fn() };
vi.mock("@/lib/clients/omdb", () => ({ omdb: mockOmdb }));
const mockTmdb = { isEnabled: vi.fn(() => true), getMovie: vi.fn(), getMovieVideos: vi.fn(), movieRecommendations: vi.fn() };
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
const mockCachedMovies = vi.fn();
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: (...args: unknown[]) => mockCachedMovies(...args),
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
  mockTmdb.getMovie.mockResolvedValue({ overview: "o", genres: [], credits: { cast: [] } });
  mockTmdb.getMovieVideos.mockResolvedValue({ results: [] });
  mockBazarr.getMovieDetails.mockResolvedValue(null);
  mockRadarr.getQueue.mockResolvedValue({ records: [] });
  mockCachedMovies.mockResolvedValue([]);
});

describe("GET /api/radarr/movies/[id]/info", () => {
  it("returns 404 when the movie doesn't exist in Radarr", async () => {
    mockCachedMovies.mockResolvedValue([{ id: 2, tmdbId: 7 }]);
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(404);
  });

  // 18/11/2026 : la fiche demandait `/movie/{id}` à Radarr à chaque ouverture et à chaque survol, et un
  // Radarr injoignable répondait 404 « Film introuvable » — un refus distinct par titre survolé, ce que
  // le pare-feu compte pour bannir. Le film vient de la liste gardée au chaud ; une panne se nomme.
  it("reads the movie from the kept list, never from Radarr directly", async () => {
    mockCachedMovies.mockResolvedValue([{ id: 1, tmdbId: 42 }]);
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(200);
    expect(mockRadarr.getMovie).not.toHaveBeenCalled();
  });

  it("names a Radarr outage (502) instead of answering « not found »", async () => {
    mockCachedMovies.mockRejectedValue(new Error("radarr ne répond pas"));
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(502);
  });

  it("picks the official YouTube trailer over a non-official one", async () => {
    mockCachedMovies.mockResolvedValue([{ id: 1, tmdbId: 42 }]);
    mockTmdb.getMovieVideos.mockResolvedValue({
      results: [
        { type: "Trailer", site: "YouTube", official: false, key: "unofficial" },
        { type: "Trailer", site: "YouTube", official: true, key: "official" },
      ],
    });
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.trailerKey).toBe("official");
  });

  it("falls back to a non-official trailer when no official one exists", async () => {
    mockCachedMovies.mockResolvedValue([{ id: 1, tmdbId: 42 }]);
    mockTmdb.getMovieVideos.mockResolvedValue({
      results: [{ type: "Trailer", site: "YouTube", official: false, key: "unofficial" }],
    });
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.trailerKey).toBe("unofficial");
  });

  it("matches the active download to this movie by id", async () => {
    mockCachedMovies.mockResolvedValue([{ id: 1, tmdbId: 42 }]);
    mockRadarr.getQueue.mockResolvedValue({
      records: [{ movieId: 1, title: "Dune", status: "downloading", size: 100, sizeleft: 50, indexer: "x" }],
    });
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.activeDownload).toMatchObject({ title: "Dune", status: "downloading" });
  });

  // 18/11/2026 : la fiche du cinéma recevait les sous-titres de Bazarr et le téléchargement en cours (nom
  // du torrent, indexeur), que seule la page de gestion affiche — et attendait Bazarr pour eux.
  it("gives a plain account none of what only the management page shows, without asking Bazarr", async () => {
    mockSession.mockImplementation(async () => ({ role: "user" }));
    mockCachedMovies.mockResolvedValue([{ id: 1, tmdbId: 42 }]);
    mockRadarr.getQueue.mockResolvedValue({ records: [{ movieId: 1, title: "Dune.2021.1080p-GRP", indexer: "x" }] });
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const body = await (await GET(fakeReq(), params("1"))).json();
    expect(body.activeDownload).toBeNull();
    expect(body.subtitles).toEqual([]);
    expect(body.audioLanguages).toEqual([]);
    expect(mockBazarr.getMovieDetails).not.toHaveBeenCalled();
    expect(mockRadarr.getQueue).not.toHaveBeenCalled();
    expect(body.tmdb).not.toBeNull();
  });

  it("skips OMDb and TMDB calls when they are disabled/no imdbId", async () => {
    mockCachedMovies.mockResolvedValue([{ id: 1, tmdbId: 42, imdbId: null }]);
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.tmdb).toBeNull();
    expect(body.imdbRating).toBeNull();
    expect(mockOmdb.getRating).not.toHaveBeenCalled();
  });
});

describe("GET /api/radarr/movies/[id]/similar", () => {
  it("returns empty items when TMDB is disabled", async () => {
    mockTmdb.isEnabled.mockReturnValue(false);
    const { GET } = await import("@/app/api/radarr/movies/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  it("returns 404 when the source movie doesn't exist", async () => {
    mockRadarr.getMovie.mockRejectedValue(new Error("nope"));
    const { GET } = await import("@/app/api/radarr/movies/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    expect(res.status).toBe(404);
  });

  it("marks recommended movies already in the library as in-library, with their radarrId", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 1, tmdbId: 42 });
    mockTmdb.movieRecommendations.mockResolvedValue({
      results: [{ id: 99, title: "Rec", poster_path: "/p.jpg", vote_average: 7, release_date: "2020-01-01" }],
    });
    mockCachedMovies.mockResolvedValue([{ tmdbId: 99, id: 55 }]);
    const { GET } = await import("@/app/api/radarr/movies/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ tmdbId: 99, radarrId: 55, inLibrary: true });
  });

  it("filters out recommendations with no poster", async () => {
    mockRadarr.getMovie.mockResolvedValue({ id: 1, tmdbId: 42 });
    mockTmdb.movieRecommendations.mockResolvedValue({
      results: [{ id: 99, title: "Rec", poster_path: null, vote_average: 7, release_date: "2020-01-01" }],
    });
    const { GET } = await import("@/app/api/radarr/movies/[id]/similar/route");
    const res = await GET(fakeReq(), params("1"));
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });

  it("renvoie le logo du titre, résolu par le même module que le mode cinéma", async () => {
    // Donc par le même cache : l'image demandée pour une carte du mode cinéma sert à la fiche,
    // et inversement. C'est ce qui permet à la fiche d'afficher le titre tel que ses propres
    // graphistes l'ont dessiné, et de retomber sur la typo quand il n'y en a pas.
    mockCachedMovies.mockResolvedValue([{ id: 1, tmdbId: 42 }]);
    const { GET } = await import("@/app/api/radarr/movies/[id]/info/route");
    const body = await (await GET(fakeReq(), params("1"))).json();
    expect(body.logoUrl).toBe("https://image.tmdb.org/logo.png");
    expect(mockTitleLogo).toHaveBeenCalledWith(42, "movie");
  });
});
