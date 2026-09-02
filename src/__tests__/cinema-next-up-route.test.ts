import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockGetNextUpGlobal = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getNextUpGlobal: (...a: unknown[]) => mockGetNextUpGlobal(...a) } }));

function fakeReq(cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

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
});
