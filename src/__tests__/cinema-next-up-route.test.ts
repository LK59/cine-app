import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockGetNextUpGlobal = vi.fn();
const mockGetItemProviderIds = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getNextUpGlobal: (...a: unknown[]) => mockGetNextUpGlobal(...a),
    getItemProviderIds: (...a: unknown[]) => mockGetItemProviderIds(...a),
  },
}));
const mockGetSeries = vi.fn();
vi.mock("@/lib/clients/sonarr", () => ({ sonarr: { getSeries: () => mockGetSeries() } }));

function fakeReq(cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetItemProviderIds.mockResolvedValue(null);
  mockGetSeries.mockResolvedValue([]);
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
        IndexNumber: 1,
        RunTimeTicks: 1_200_000_000,
        ImageTags: {},
      },
    ]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items[0].resumeTicks).toBeNull();
    expect(body.items[0].thumbnailUrl).toBeNull();
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
  it("resolves an episode to its Sonarr series through the series' TVDB id", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      { Id: "ep-1", Name: "Pilote", Type: "Episode", SeriesName: "Une Série", SeriesId: "series-9", ParentIndexNumber: 1, IndexNumber: 1 },
    ]);
    mockGetItemProviderIds.mockResolvedValue({ ProviderIds: { Tvdb: "424242" } });
    mockGetSeries.mockResolvedValue([{ id: 77, tvdbId: 424242 }]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();

    expect(body.items[0].sonarrId).toBe(77);
    expect(mockGetItemProviderIds).toHaveBeenCalledWith("jf-1", "series-9");
  });

  it("leaves the link empty for a series Sonarr does not have", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      { Id: "ep-1", Name: "Pilote", Type: "Episode", SeriesName: "Une Série", SeriesId: "series-9", ParentIndexNumber: 1, IndexNumber: 1 },
    ]);
    mockGetItemProviderIds.mockResolvedValue({ ProviderIds: { Tvdb: "424242" } });
    mockGetSeries.mockResolvedValue([{ id: 77, tvdbId: 999 }]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();
    expect(body.items[0].sonarrId).toBeNull();
  });

  /** Une seule interrogation par série, même si plusieurs épisodes en viennent. */
  it("asks for each series once, however many of its episodes are up next", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockGetNextUpGlobal.mockResolvedValue([
      { Id: "ep-1", Name: "A", Type: "Episode", SeriesId: "series-9", ParentIndexNumber: 1, IndexNumber: 1 },
      { Id: "ep-2", Name: "B", Type: "Episode", SeriesId: "series-9", ParentIndexNumber: 1, IndexNumber: 2 },
    ]);
    mockGetItemProviderIds.mockResolvedValue({ ProviderIds: { Tvdb: "1" } });
    mockGetSeries.mockResolvedValue([{ id: 5, tvdbId: 1 }]);

    const { GET } = await import("@/app/api/cinema/next-up/route");
    const body = await (await GET(fakeReq())).json();

    expect(mockGetItemProviderIds).toHaveBeenCalledTimes(1);
    expect(body.items.map((i: { sonarrId: number }) => i.sonarrId)).toEqual([5, 5]);
  });
});
