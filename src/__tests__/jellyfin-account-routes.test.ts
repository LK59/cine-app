import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockJellyfin = {
  markPlayed: vi.fn(),
  markUnplayed: vi.fn(),
  getSeriesEpisodes: vi.fn(),
  getNextUp: vi.fn(),
  getPlayedCount: vi.fn(),
  getRecentlyPlayed: vi.fn(),
  reportPlaybackStopped: vi.fn(),
};
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
let playerEnabled = true;
vi.mock("@/lib/config", () => ({
  config: {
    get player() { return { enabled: playerEnabled }; },
    jellyfin: { publicUrl: "", url: "http://jellyfin.local" },
  },
}));

function fakeReq(body?: unknown, params: Record<string, string> = {}, cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    json: async () => body ?? null,
    nextUrl: { searchParams: new URLSearchParams(params) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  playerEnabled = true;
});

describe("POST /api/jellyfin/played", () => {
  it("returns 403 without a Jellyfin session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { POST } = await import("@/app/api/jellyfin/played/route");
    const res = await POST(fakeReq({}));
    expect(res.status).toBe(403);
  });

  it("returns 400 when played is not a boolean", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const { POST } = await import("@/app/api/jellyfin/played/route");
    const res = await POST(fakeReq({ itemId: "abc" }));
    expect(res.status).toBe(400);
  });

  it("calls markPlayed when played=true", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const { POST } = await import("@/app/api/jellyfin/played/route");
    await POST(fakeReq({ itemId: "abc", played: true }));
    expect(mockJellyfin.markPlayed).toHaveBeenCalledWith("jf-1", "abc");
  });

  it("calls markUnplayed when played=false", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const { POST } = await import("@/app/api/jellyfin/played/route");
    await POST(fakeReq({ itemId: "abc", played: false }));
    expect(mockJellyfin.markUnplayed).toHaveBeenCalledWith("jf-1", "abc");
  });
});

describe("GET /api/jellyfin/series/[seriesId]/episodes", () => {
  const validId = "a".repeat(32);

  it("rejects a malformed seriesId before touching the session/Jellyfin", async () => {
    const { GET } = await import("@/app/api/jellyfin/series/[seriesId]/episodes/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ seriesId: "not-a-valid-id" }) });
    expect(res.status).toBe(400);
    expect(mockVerifySessionFull).not.toHaveBeenCalled();
  });

  it("returns 403 without a Jellyfin session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/jellyfin/series/[seriesId]/episodes/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ seriesId: validId }) });
    expect(res.status).toBe(403);
  });

  it("fetches episodes and next-up in parallel for a valid session", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockJellyfin.getSeriesEpisodes.mockResolvedValue([{ Id: "e1" }]);
    mockJellyfin.getNextUp.mockResolvedValue([{ Id: "e2" }]);
    const { GET } = await import("@/app/api/jellyfin/series/[seriesId]/episodes/route");
    const res = await GET(fakeReq(), { params: Promise.resolve({ seriesId: validId }) });
    const body = await res.json();
    expect(mockJellyfin.getSeriesEpisodes).toHaveBeenCalledWith("jf-1", validId);
    expect(body).toEqual({ episodes: [{ Id: "e1" }], nextUp: [{ Id: "e2" }] });
  });
});

describe("GET /api/jellyfin/playback", () => {
  it("returns 403 without jfId", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/jellyfin/playback/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(403);
  });

  it("maps recently played episodes with series name and season/episode numbers", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    mockJellyfin.getPlayedCount.mockResolvedValue({ TotalRecordCount: 3 });
    mockJellyfin.getRecentlyPlayed.mockImplementation((_id: string, type: string) =>
      type === "Episode"
        ? Promise.resolve({ Items: [{ Id: "e1", Name: "Ep", SeriesName: "Show", ParentIndexNumber: 1, IndexNumber: 2 }] })
        : Promise.resolve({ Items: [] })
    );
    const { GET } = await import("@/app/api/jellyfin/playback/route");
    const res = await GET(fakeReq());
    const body = await res.json();
    expect(body.recentEpisodes[0]).toMatchObject({ seriesName: "Show", season: 1, episode: 2 });
    expect(body.counts.moviesPlayed).toBe(3);
  });
});

describe("POST /api/jellyfin/playback/stop", () => {
  it("returns 404 when the in-app player is disabled", async () => {
    playerEnabled = false;
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    const res = await POST(fakeReq({}));
    expect(res.status).toBe(404);
  });

  it("returns 403 without jfToken", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    const res = await POST(fakeReq({}));
    expect(res.status).toBe(403);
  });

  it("returns 400 when required fields are missing", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    const res = await POST(fakeReq({ itemId: "abc" }));
    expect(res.status).toBe(400);
  });

  it("reports the stop with defaulted positionTicks", async () => {
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    await POST(fakeReq({ itemId: "abc", playSessionId: "s", mediaSourceId: "m" }));
    expect(mockJellyfin.reportPlaybackStopped).toHaveBeenCalledWith("jf-1", "abc", "tok", "s", "m", 0);
  });
});

describe("GET /api/jellyfin/redirect", () => {
  it("returns 400 without itemId", async () => {
    const { GET } = await import("@/app/api/jellyfin/redirect/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(400);
  });

  it("redirects to the Jellyfin web UI details page, without an api_key in the URL", async () => {
    const { GET } = await import("@/app/api/jellyfin/redirect/route");
    const res = await GET(fakeReq(undefined, { itemId: "abc123" }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/web/index.html#!/details?id=abc123");
    expect(location).not.toContain("api_key");
  });
});
