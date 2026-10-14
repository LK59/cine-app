import { describe, it, expect, vi, beforeEach } from "vitest";
// Radarr et Sonarr supposés configurés : non configurés, ils ne sont plus interrogés (DECISIONS.md §89).
vi.mock("@/lib/serviceConfigured", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serviceConfigured")>()),
  serviceConfigured: () => true,
}));
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockGetNextUpGlobal = vi.fn();
const mockGetItemProviderIds = vi.fn();
const mockGetSeriesLastPlayed = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getNextUpGlobal: (...a: unknown[]) => mockGetNextUpGlobal(...a),
    getItemProviderIds: (...a: unknown[]) => mockGetItemProviderIds(...a),
    getSeriesLastPlayed: (...a: unknown[]) => mockGetSeriesLastPlayed(...a),
    // Le catalogue, d'où vient le lien vers la fiche (le dossier, DECISIONS.md §89).
    getAllSeriesAdmin: () => mockAllSeriesAdmin(),
    getAllMoviesAdmin: async () => [],
    countEpisodesAdmin: async () => 1,
  },
}));
const mockAllSeriesAdmin = vi.fn();
const mockGetSeries = vi.fn();
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: { getSeries: () => mockGetSeries() } }));
vi.mock("@/lib/clients/radarr", () => ({ radarr: { getMovies: async () => [] } }));

function fakeReq(cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  // La route lit maintenant Sonarr et les identifiants externes à travers le cache du serveur,
  // qui vit dans le module et donc d'un test à l'autre : sans cette purge, le deuxième test
  // reçoit la bibliothèque du premier.
  const cache = await import("@/lib/server-cache");
  cache.invalidateLibrary();
  cache.invalidateJellyfinLibrary();
  mockGetItemProviderIds.mockResolvedValue(null);
  mockGetSeries.mockResolvedValue([]);
  mockAllSeriesAdmin.mockResolvedValue([]);
  mockGetSeriesLastPlayed.mockResolvedValue(null);
});

describe("GET /api/cinema/next-up", () => {
  it("returns an empty list when the session has no Jellyfin account linked", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.items).toEqual([]);
    expect(mockGetNextUpGlobal).not.toHaveBeenCalled();
  });

  it("maps an episode with progress into a resumable item", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      {
        Id: "ep-1",
        Name: "The One With The Thing",
        Type: "Episode",
        SeriesName: "Some Show",
        ParentIndexNumber: 2,
        IndexNumber: 5,
        RunTimeTicks: 1_200_000_000,
        UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: 300_000_000 },
        ImageTags: { Primary: "tag123" },
      },
    ]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      jellyfinItemId: "ep-1",
      title: "Some Show",
      seasonNumber: 2,
      episodeNumber: 5,
      resumeTicks: 300_000_000,
      runtimeTicks: 1_200_000_000,
      thumbnailUrl: "/api/jellyfin/image?itemId=ep-1&tag=tag123",
    });
  });

  it("maps an unstarted next episode with null resumeTicks (the 'Lire' case)", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      {
        Id: "ep-2",
        Name: "Fresh Episode",
        Type: "Episode",
        SeriesName: "Another Show",
        ParentIndexNumber: 1,
        IndexNumber: 2,
        RunTimeTicks: 1_200_000_000,
        ImageTags: {},
      },
    ]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items[0].resumeTicks).toBeNull();
    expect(body.items[0].thumbnailUrl).toBeNull();
  });

  // Jellyfin propose chaque série qui arrive sur son premier épisode : elles s'accumulaient devant
  // ce qu'on regardait vraiment (07/10/2026). Un premier épisode entamé reste une reprise.
  it("écarte une série proposée sur S1 · É1 jamais commencé, garde un premier épisode entamé", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      { Id: "pilot-new", Name: "Pilote", Type: "Episode", ParentIndexNumber: 1, IndexNumber: 1, UserData: { PlaybackPositionTicks: 0 } },
      { Id: "pilot-started", Name: "Pilote", Type: "Episode", ParentIndexNumber: 1, IndexNumber: 1, UserData: { PlaybackPositionTicks: 600_000_000 } },
      { Id: "s2e1", Name: "Saison 2", Type: "Episode", ParentIndexNumber: 2, IndexNumber: 1 },
    ]);
    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.items.map((i: { jellyfinItemId: string }) => i.jellyfinItemId)).toEqual(["pilot-started", "s2e1"]);
  });

  it("date chaque épisode par sa dernière lecture, ou par celle de sa série s'il n'a jamais été ouvert", async () => {
    // 28/09/2026 : l'ordre de « Reprendre » — le dernier lu d'abord (`continueOrder`).
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      { Id: "ep-a", Name: "A", Type: "Episode", SeriesId: "s-a", UserData: { Played: false, PlayCount: 0, LastPlayedDate: "2026-09-28T09:27:30Z" } },
      { Id: "ep-b", Name: "B", Type: "Episode", SeriesId: "s-b", UserData: { Played: false, PlayCount: 0 } },
      { Id: "ep-c", Name: "C", Type: "Episode", SeriesId: "s-c" },
    ]);
    mockGetSeriesLastPlayed.mockImplementation(async (_user: string, seriesId: string) => {
      if (seriesId === "s-b") return "2026-09-27T20:00:00Z";
      throw new Error("jellyfin");
    });
    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.items.map((i: { lastPlayedAt: string | null }) => i.lastPlayedAt)).toEqual(["2026-09-28T09:27:30Z", "2026-09-27T20:00:00Z", null]);
    // Seulement pour ceux qui n'ont pas de date à eux.
    expect(mockGetSeriesLastPlayed).toHaveBeenCalledTimes(2);
  });

  it("falls back to an empty list when the Jellyfin call fails", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockRejectedValue(new Error("jellyfin down"));

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items).toEqual([]);
  });

  /**
   * Ce qui relie une reprise à sa fiche.
   *
   * Sur le téléphone comme sur le bureau, une carte de reprise ouvre la fiche de la série — et
   * pour l'ouvrir, il faut savoir laquelle. Jellyfin ne connaît que son propre identifiant : le
   * pont passe par le TVDB de la série, comme la liste des films passe par le TMDB.
   */
  // *Shōgun* (14/10/2026) : Jellyfin lisait le dossier comme la série de 1980. Le lien vient du
  // dossier, pas du TVDB que Jellyfin a posé — et sans rien lui redemander.
  it("resolves an episode to the series Sonarr keeps in its folder", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      { Id: "ep-1", Name: "Pilote", Type: "Episode", SeriesName: "Une Série", SeriesId: "series-9", ParentIndexNumber: 1, IndexNumber: 3 },
    ]);
    mockAllSeriesAdmin.mockResolvedValue([{ Id: "series-9", Name: "Autre chose", ProviderIds: { Tvdb: "80284" }, Path: "/media/tv/Une Série" }]);
    mockGetSeries.mockResolvedValue([{ id: 77, tvdbId: 424242, title: "Une Série", path: "/tv/Une Série", statistics: { episodeFileCount: 3 } }]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items[0].sonarrId).toBe(77);
    expect(mockGetItemProviderIds).not.toHaveBeenCalled();
  });

  it("leaves the link empty for a series Sonarr does not have", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      { Id: "ep-1", Name: "Pilote", Type: "Episode", SeriesName: "Une Série", SeriesId: "series-9", ParentIndexNumber: 1, IndexNumber: 3 },
    ]);
    mockGetSeries.mockResolvedValue([{ id: 77, tvdbId: 999, title: "Rien à voir", path: "/tv/Rien à voir", statistics: { episodeFileCount: 3 } }]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.items[0].sonarrId).toBeNull();
  });

  /** Plusieurs épisodes d'une même série : la même fiche, sans requête par épisode. */
  it("gives every episode of a series the same sheet", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      { Id: "ep-1", Name: "A", Type: "Episode", SeriesId: "series-9", ParentIndexNumber: 1, IndexNumber: 3 },
      { Id: "ep-2", Name: "B", Type: "Episode", SeriesId: "series-9", ParentIndexNumber: 1, IndexNumber: 4 },
    ]);
    mockAllSeriesAdmin.mockResolvedValue([{ Id: "series-9", Name: "S", ProviderIds: { Tvdb: "1" }, Path: "/media/tv/S" }]);
    mockGetSeries.mockResolvedValue([{ id: 5, tvdbId: 1, title: "S", path: "/tv/S", statistics: { episodeFileCount: 2 } }]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();

    expect(mockGetItemProviderIds).not.toHaveBeenCalled();
    expect(body.items.map((i: { sonarrId: number }) => i.sonarrId)).toEqual([5, 5]);
  });
});
