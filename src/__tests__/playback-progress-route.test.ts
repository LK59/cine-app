import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockJellyfin = { reportPlaybackProgress: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));

let playerEnabled = true;
vi.mock("@/lib/config", () => ({ config: { get player() { return { enabled: playerEnabled }; } } }));

function fakeReq(body: unknown, cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  playerEnabled = true;
});

describe("POST /api/jellyfin/playback/progress", () => {
  it("returns 404 when the in-app player is disabled", async () => {
    playerEnabled = false;
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({}));
    expect(res.status).toBe(404);
  });

  it("returns 403 when the session has no Jellyfin account linked", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({}));
    expect(res.status).toBe(403);
  });

  it("returns 400 when required fields are missing", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({ itemId: "abc" }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric positionTicks", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({ itemId: "abc", playSessionId: "s", mediaSourceId: "m", positionTicks: "not-a-number" }));
    expect(res.status).toBe(400);
  });

  it("reports progress to Jellyfin with the session's own jfId/jfToken, defaulting playMethod to Transcode", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({ itemId: "abc", playSessionId: "s", mediaSourceId: "m", positionTicks: 12345 }));
    expect(res.status).toBe(200);
    expect(mockJellyfin.reportPlaybackProgress).toHaveBeenCalledWith("jf-1", "abc", "tok", "s", "m", 12345, "Transcode");
  });

  it("forwards the client-reported playMethod to Jellyfin", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    await POST(fakeReq({ itemId: "abc", playSessionId: "s", mediaSourceId: "m", positionTicks: 1, playMethod: "DirectPlay" }));
    expect(mockJellyfin.reportPlaybackProgress).toHaveBeenCalledWith("jf-1", "abc", "tok", "s", "m", 1, "DirectPlay");
  });

  it("returns 502 when Jellyfin's progress report call fails", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.reportPlaybackProgress.mockRejectedValue(new Error("jellyfin unreachable"));
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({ itemId: "abc", playSessionId: "s", mediaSourceId: "m", positionTicks: 1 }));
    expect(res.status).toBe(502);
  });
});
