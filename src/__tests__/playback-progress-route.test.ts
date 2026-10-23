import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockJellyfin = { reportPlaybackProgress: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
const mockJfDevice = vi.fn<(jti: string) => string | null>(() => null);
vi.mock("@/lib/db", () => ({ sessionDb: { jfDevice: (jti: string) => mockJfDevice(jti) } }));
// Session sans `jti` ni appareil gardé, sans signature : l'ancien identifiant, le nom de repli.
const NO_DEVICE = { name: "Navigateur", id: null };

let playerEnabled = true;
vi.mock("@/lib/config", () => ({ config: { get player() { return { enabled: playerEnabled }; } } }));

function fakeReq(body: unknown, cookie = "t", headers: Record<string, string> = {}): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    json: async () => body,
    headers: new Headers(headers),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  playerEnabled = true;
});

describe("POST /api/jellyfin/playback/progress", () => {
  // Un appareil réel, une seule identité chez Jellyfin : le rapport reprend l'appareil inscrit à la
  // connexion de cette session, sous le libellé de l'appareil qui l'envoie (29/09/2026).
  it("s'annonce sous l'appareil de la connexion de la session, iPad reconnu par l'indice", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok", jti: "jti-9" });
    mockJfDevice.mockImplementation((jti) => (jti === "jti-9" ? "cine-app-0000-1111" : null));
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    await POST(
      fakeReq(
        { itemId: "0123456789abcdef0123456789abcdef", playSessionId: "s", mediaSourceId: "m", positionTicks: 5, client: "CineEngine By CineApp" },
        "t",
        { "user-agent": ipad, "x-cine-touch": "1" }
      )
    );
    expect(mockJellyfin.reportPlaybackProgress).toHaveBeenCalledWith(
      "jf-1", "0123456789abcdef0123456789abcdef", "tok", "s", "m", 5, "Transcode", "Lumen by Laterna", false,
      { name: "iPad · Safari", id: "cine-app-0000-1111" }
    );
  });

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
    const res = await POST(fakeReq({ itemId: "0123456789abcdef0123456789abcdef" }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric positionTicks", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({ itemId: "0123456789abcdef0123456789abcdef", playSessionId: "s", mediaSourceId: "m", positionTicks: "not-a-number" }));
    expect(res.status).toBe(400);
  });

  it("reports progress to Jellyfin with the session's own jfId/jfToken, defaulting playMethod to Transcode", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({ itemId: "0123456789abcdef0123456789abcdef", playSessionId: "s", mediaSourceId: "m", positionTicks: 12345 }));
    expect(res.status).toBe(200);
    expect(mockJellyfin.reportPlaybackProgress).toHaveBeenCalledWith(
      "jf-1", "0123456789abcdef0123456789abcdef", "tok", "s", "m", 12345, "Transcode", "Laterna", false, NO_DEVICE
    );
  });

  it("forwards the client-reported playMethod to Jellyfin", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    await POST(fakeReq({ itemId: "0123456789abcdef0123456789abcdef", playSessionId: "s", mediaSourceId: "m", positionTicks: 1, playMethod: "DirectPlay" }));
    expect(mockJellyfin.reportPlaybackProgress).toHaveBeenCalledWith(
      "jf-1", "0123456789abcdef0123456789abcdef", "tok", "s", "m", 1, "DirectPlay", "Laterna", false, NO_DEVICE
    );
  });

  it("returns 502 when Jellyfin's progress report call fails", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    mockJellyfin.reportPlaybackProgress.mockRejectedValue(new Error("jellyfin unreachable"));
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    const res = await POST(fakeReq({ itemId: "0123456789abcdef0123456789abcdef", playSessionId: "s", mediaSourceId: "m", positionTicks: 1 }));
    expect(res.status).toBe(502);
  });
});

describe("le nom du client, et l'état de pause", () => {
  it("transmet le nom du moteur et une pause honnête", async () => {
    // Jellyfin's dashboard names a client from the header of each report, so this is the only
    // thing that tells the two players apart on the server.
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    await POST(
      fakeReq({
        itemId: "0123456789abcdef0123456789abcdef",
        playSessionId: "s",
        mediaSourceId: "m",
        positionTicks: 5,
        client: "CineEngine By CineApp",
        isPaused: true,
      })
    );
    expect(mockJellyfin.reportPlaybackProgress).toHaveBeenCalledWith(
      "jf-1", "0123456789abcdef0123456789abcdef", "tok", "s", "m", 5, "Transcode", "Lumen by Laterna", true, NO_DEVICE
    );
  });

  it("refuse un nom inventé plutôt que de le laisser passer", async () => {
    // The name comes from the browser and lands in the server's session list and its history.
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    await POST(
      fakeReq({ itemId: "0123456789abcdef0123456789abcdef", playSessionId: "s", mediaSourceId: "m", positionTicks: 5, client: "<script>Netflix" })
    );
    expect(mockJellyfin.reportPlaybackProgress).toHaveBeenCalledWith(
      "jf-1", "0123456789abcdef0123456789abcdef", "tok", "s", "m", 5, "Transcode", "Laterna", false, NO_DEVICE
    );
  });

  it("enregistre la présence de l'appelant, titre gardé du signal d'ouverture (13/10/2026)", async () => {
    // Pendant un film, le battement tient lieu de signal de présence : `PresencePinger` se tait.
    const presence = await import("@/lib/activity/presence");
    presence.__testing.reset();
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", jfToken: "tok", jti: "jti-7" });
    mockJellyfin.reportPlaybackProgress.mockResolvedValue(undefined);
    const item = "0123456789abcdef0123456789abcdef";
    // Le signal d'ouverture du pinger, avec le titre.
    presence.recordBeat("jti-7", { user: "louis", jfId: "jf-1", at: Date.now() - 200_000, visible: true, playing: { itemId: item, title: "Le Film" }, device: "Mac · Safari" });
    const { POST } = await import("@/app/api/jellyfin/playback/progress/route");
    await POST(fakeReq({ itemId: item, playSessionId: "s", mediaSourceId: "m", positionTicks: 5, visible: true }, "t", { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15" }));
    // Le signal d'ouverture, vieux de 200 s, aurait expiré (150 s) : le battement le renouvelle.
    expect(presence.presenceOf("louis")).toMatchObject({ state: "playing", playing: { itemId: item, title: "Le Film" } });
    expect(presence.presenceOf("louis").devices).toEqual(["Mac · Safari"]);
  });
});
