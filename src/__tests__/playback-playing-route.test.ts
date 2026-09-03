import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockJellyfin = { reportPlaybackStart: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));

let playerEnabled = true;
vi.mock("@/lib/config", () => ({ config: { get player() { return { enabled: playerEnabled }; } } }));

function fakeReq(body: unknown, cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    json: async () => body,
  } as unknown as NextRequest;
}

const complete = { itemId: "abc", playSessionId: "s", mediaSourceId: "m" };

beforeEach(() => {
  vi.clearAllMocks();
  playerEnabled = true;
  mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
});

describe("POST /api/jellyfin/playback/playing", () => {
  it("ouvre la session côté serveur au nom du moteur", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/playing/route");
    const res = await POST(fakeReq({ ...complete, client: "CineEngine By CineApp" }));
    expect(res.status).toBe(200);
    // Reported with the viewer's own token, never the admin key: this is their watch history.
    expect(mockJellyfin.reportPlaybackStart).toHaveBeenCalledWith(
      "jf-1", "abc", "tok", "s", "m", "DirectPlay", "CineEngine By CineApp"
    );
  });

  it("retombe sur le nom de l'app pour un nom inventé", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/playing/route");
    await POST(fakeReq({ ...complete, client: "Netflix" }));
    expect(mockJellyfin.reportPlaybackStart).toHaveBeenCalledWith(
      "jf-1", "abc", "tok", "s", "m", "DirectPlay", "CineApp"
    );
  });

  it("refuse une session incomplète, un compte non lié, et le lecteur désactivé", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/playing/route");
    expect((await POST(fakeReq({ itemId: "abc" }))).status).toBe(400);

    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    expect((await POST(fakeReq(complete))).status).toBe(403);

    playerEnabled = false;
    expect((await POST(fakeReq(complete))).status).toBe(404);
    expect(mockJellyfin.reportPlaybackStart).not.toHaveBeenCalled();
  });

  it("remonte une panne Jellyfin en 502 plutôt qu'en échec silencieux", async () => {
    mockJellyfin.reportPlaybackStart.mockRejectedValue(new Error("jellyfin est tombé"));
    const { POST } = await import("@/app/api/jellyfin/playback/playing/route");
    expect((await POST(fakeReq(complete))).status).toBe(502);
  });
});
