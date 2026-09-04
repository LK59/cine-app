import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/config", () => ({ config: { jellyseerr: { apiKey: "k" }, tmdb: { apiKey: "k" } } }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));

const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

const jellyseerr = {
  getMovieMedia: vi.fn(),
  getTvMedia: vi.fn(),
  createRequest: vi.fn(),
  deleteRequest: vi.fn(),
  deleteMedia: vi.fn(),
  getMe: vi.fn(),
  getRequestsByUser: vi.fn(),
  getUsers: vi.fn(),
};
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr }));

const tmdbClient = { isEnabled: () => true, getMovie: vi.fn(), getTv: vi.fn() };
vi.mock("@/lib/clients/tmdb", () => ({
  createTmdbClient: () => tmdbClient,
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));

vi.mock("@/lib/server-cache", () => ({
  cachedMovies: async () => [{ id: 42, tmdbId: 603 }],
  cachedSeries: async () => [{ id: 7, tmdbId: 1399 }],
  cachedJellyfinMovies: async () => [
    { Id: "jf1", Name: "Vu", ProviderIds: { Tmdb: "603" }, ProductionYear: 1999, UserData: { Played: true, IsFavorite: false, PlayCount: 1 } },
    { Id: "jf2", Name: "Favori", ProviderIds: { Tmdb: "999" }, ProductionYear: 2001, UserData: { Played: false, IsFavorite: true, PlayCount: 0 } },
  ],
  cachedJellyfinSeries: async () => [],
  cachedMovieInfo: vi.fn(),
  cachedTvInfo: vi.fn(),
  getProviderIdCI: (ids: Record<string, string> | undefined, key: string) =>
    ids ? ids[key] ?? ids[key[0].toUpperCase() + key.slice(1)] : undefined,
  withCache: async (_k: string, _t: number, fn: () => unknown) => fn(),
  TTL: { LONG: 1, MEDIUM: 1, MEDIA_INFO: 1 },
}));

const watchlistDb = { get: vi.fn(), getAll: vi.fn() };
vi.mock("@/lib/db", () => ({ watchlistDb, pendingRequestDb: { add: vi.fn() } }));

function req(cookie: string | null = "t"): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" && cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

function jsonReq(body: unknown, cookie: string | null = "t"): NextRequest {
  return { ...req(cookie), json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ u: "louis", jfId: "jf-louis", jfUser: "louis", role: "user", jsCookie: "s%3Amine" });
  watchlistDb.get.mockReturnValue(undefined);
  watchlistDb.getAll.mockReturnValue([]);
});

describe("GET /api/player/title", () => {
  it("refuses an anonymous caller", async () => {
    mockVerify.mockResolvedValue(null);
    const { GET } = await import("@/app/api/player/title/[type]/[tmdbId]/route");
    const res = await GET(req(null), { params: Promise.resolve({ type: "movie", tmdbId: "603" }) });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown media type and a junk id", async () => {
    const { GET } = await import("@/app/api/player/title/[type]/[tmdbId]/route");
    expect((await GET(req(), { params: Promise.resolve({ type: "album", tmdbId: "603" }) })).status).toBe(400);
    expect((await GET(req(), { params: Promise.resolve({ type: "movie", tmdbId: "abc" }) })).status).toBe(400);
  });

  it("reports the library id for a title we already have, and no request state", async () => {
    tmdbClient.getMovie.mockResolvedValue({
      title: "Skyfall", release_date: "2012-10-24", overview: "…", genres: [], runtime: 143,
      vote_average: 7.2, poster_path: "/p.jpg", backdrop_path: "/b.jpg", credits: { cast: [] },
    });
    jellyseerr.getMovieMedia.mockResolvedValue({});
    const { GET } = await import("@/app/api/player/title/[type]/[tmdbId]/route");
    const body = await (await GET(req(), { params: Promise.resolve({ type: "movie", tmdbId: "603" }) })).json();
    expect(body.libraryId).toBe(42);
    expect(body.requestState).toBeNull();
    expect(body.year).toBe(2012);
  });

  // Un film demandé avant sa sortie doit le dire, sinon « en cours » tourne pendant des mois.
  it("says a requested, unreleased title is not out yet", async () => {
    tmdbClient.getMovie.mockResolvedValue({
      title: "À venir", release_date: "2099-01-01", overview: "", genres: [], runtime: null,
      vote_average: 0, poster_path: null, backdrop_path: null, credits: { cast: [] },
    });
    jellyseerr.getMovieMedia.mockResolvedValue({ mediaInfo: { id: 1, status: 3 } });
    const { GET } = await import("@/app/api/player/title/[type]/[tmdbId]/route");
    const body = await (await GET(req(), { params: Promise.resolve({ type: "movie", tmdbId: "555" }) })).json();
    expect(body.requestState).toBe("unreleased");
    expect(body.libraryId).toBeNull();
  });
});

describe("POST /api/player/requests", () => {
  it("rejects a body without a usable type or id", async () => {
    const { POST } = await import("@/app/api/player/requests/route");
    expect((await POST(jsonReq({ type: "album", tmdbId: 1 }))).status).toBe(400);
    expect((await POST(jsonReq({ type: "movie", tmdbId: 0 }))).status).toBe(400);
  });

  it("requests a movie with no season list", async () => {
    jellyseerr.createRequest.mockResolvedValue({ id: 9 });
    const { POST } = await import("@/app/api/player/requests/route");
    await POST(jsonReq({ type: "movie", tmdbId: 603 }));
    expect(jellyseerr.createRequest).toHaveBeenCalledWith("movie", 603, undefined, "s%3Amine", undefined);
  });

  // Jellyseerr plante sur une demande de série sans saisons (constaté en production), et la
  // saison 0 est le fourre-tout des bonus : personne ne la veut en demandant une série.
  it("requests every season of a series except the specials", async () => {
    jellyseerr.getTvMedia.mockResolvedValue({ seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }] });
    jellyseerr.createRequest.mockResolvedValue({ id: 10 });
    const { POST } = await import("@/app/api/player/requests/route");
    await POST(jsonReq({ type: "series", tmdbId: 1399 }));
    expect(jellyseerr.createRequest).toHaveBeenCalledWith("tv", 1399, undefined, "s%3Amine", [1, 2]);
  });

  it("falls back to TMDB's season count when Jellyseerr says nothing", async () => {
    jellyseerr.getTvMedia.mockRejectedValue(new Error("down"));
    tmdbClient.getTv.mockResolvedValue({ number_of_seasons: 3 });
    jellyseerr.createRequest.mockResolvedValue({ id: 11 });
    const { POST } = await import("@/app/api/player/requests/route");
    await POST(jsonReq({ type: "series", tmdbId: 1399 }));
    expect(jellyseerr.createRequest).toHaveBeenCalledWith("tv", 1399, undefined, "s%3Amine", [1, 2, 3]);
  });
});

describe("DELETE /api/player/requests/[id]", () => {
  it("refuses an anonymous caller and a junk id", async () => {
    const { DELETE } = await import("@/app/api/player/requests/[id]/route");
    mockVerify.mockResolvedValueOnce(null);
    expect((await DELETE(req(null), { params: Promise.resolve({ id: "3" }) })).status).toBe(401);
    expect((await DELETE(req(), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
  });

  // La garantie centrale de cette action : annuler retire la demande, et rien d'autre. Radarr et
  // Sonarr ne sont jamais touchés d'ici — le ménage s'y fait depuis le panneau d'administration.
  it("deletes the request only, never the media", async () => {
    jellyseerr.deleteRequest.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/api/player/requests/[id]/route");
    const res = await DELETE(req(), { params: Promise.resolve({ id: "328" }) });
    expect(res.status).toBe(200);
    expect(jellyseerr.deleteRequest).toHaveBeenCalledWith(328, "s%3Amine");
    expect(jellyseerr.deleteMedia).not.toHaveBeenCalled();
  });
});

describe("GET /api/player/lists", () => {
  it("reads each list from the source that owns it", async () => {
    watchlistDb.getAll.mockReturnValue([
      { tmdbId: 603, mediaType: "movie", title: "À voir", year: 1999, posterPath: null, status: "to_watch" },
      { tmdbId: 111, mediaType: "movie", title: "Laissé tomber", year: 2005, posterPath: null, status: "abandoned" },
    ]);
    jellyseerr.getMe.mockResolvedValue({ id: 5 });
    jellyseerr.getRequestsByUser.mockResolvedValue({ results: [] });

    const { GET } = await import("@/app/api/player/lists/route");
    const body = await (await GET(req())).json();

    // Local : les intentions et les jugements.
    expect(body.toWatch).toHaveLength(1);
    expect(body.toWatch[0].libraryId).toBe(42);
    expect(body.abandoned.map((i: { title: string }) => i.title)).toEqual(["Laissé tomber"]);

    // Jellyfin : ce qu'il sait déjà, et qu'on ne recopie donc pas.
    expect(body.watched.map((i: { title: string }) => i.title)).toEqual(["Vu"]);
    expect(body.favorites.map((i: { title: string }) => i.title)).toEqual(["Favori"]);
    expect(body.watched[0].jellyfinId).toBe("jf1");
  });

  it("refuses an anonymous caller", async () => {
    mockVerify.mockResolvedValue(null);
    const { GET } = await import("@/app/api/player/lists/route");
    expect((await GET(req(null))).status).toBe(401);
  });
});
