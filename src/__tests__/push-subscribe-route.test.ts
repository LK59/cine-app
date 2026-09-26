import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({
  verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args),
}));

const mockPushDb = {
  upsert: vi.fn(),
  remove: vi.fn(),
  removeForUser: vi.fn(),
  trimForUser: vi.fn(),
  removeByUser: vi.fn(),
  removeByUserEndpointPrefix: vi.fn(),
};
vi.mock("@/lib/db", () => ({ pushDb: mockPushDb }));

function fakeReq(opts: { cookie?: string; body?: unknown }): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && opts.cookie ? { value: opts.cookie } : undefined) },
    json: async () => opts.body ?? null,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/push/subscribe", () => {
  it("returns 401 without a valid session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { POST } = await import("@/app/api/push/subscribe/route");
    const res = await POST(fakeReq({ body: {} }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for an incomplete subscription payload", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { POST } = await import("@/app/api/push/subscribe/route");
    const res = await POST(fakeReq({ cookie: "t", body: { endpoint: "https://push.example/ep" } }));
    expect(res.status).toBe(400);
  });

  it("stores a valid subscription under the session's username", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { POST } = await import("@/app/api/push/subscribe/route");
    const res = await POST(fakeReq({
      cookie: "t",
      body: { endpoint: "https://fcm.googleapis.com/fcm/send/ep", keys: { p256dh: "p", auth: "a" } },
    }));
    expect(res.status).toBe(200);
    expect(mockPushDb.upsert).toHaveBeenCalledWith("louis", "https://fcm.googleapis.com/fcm/send/ep", "p", "a");
    // Plafonné à dix appareils, celui-ci toujours gardé.
    expect(mockPushDb.trimForUser).toHaveBeenCalledWith("louis", 10, "https://fcm.googleapis.com/fcm/send/ep");
  });

  // Le serveur fait un POST vers l'adresse abonnée, et `/api/push/test` en renvoyait la réponse :
  // une adresse interne se lisait depuis le navigateur (26/09/2026).
  it("refuse une adresse qui n'est pas celle d'un service push", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { POST } = await import("@/app/api/push/subscribe/route");
    for (const endpoint of [
      "http://radarr:7878/api/v3/system/status",
      "https://push.example/ep",
      "http://web.push.apple.com/abc",
      "https://web.push.apple.com:8443/abc",
      "https://web.push.apple.com.evil.example/abc",
      "https://user:pw@fcm.googleapis.com/x",
    ]) {
      const res = await POST(fakeReq({ cookie: "t", body: { endpoint, keys: { p256dh: "p", auth: "a" } } }));
      expect(res.status).toBe(400);
    }
    expect(mockPushDb.upsert).not.toHaveBeenCalled();
  });

  // Un iPhone et un Mac du même compte se désabonnaient l'un l'autre : chaque abonnement Apple
  // effaçait tous les autres, et le panneau Compte renvoie le sien à chaque ouverture (23/09/2026).
  it("keeps the account's other Apple devices subscribed", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { POST } = await import("@/app/api/push/subscribe/route");
    await POST(fakeReq({
      cookie: "t",
      body: { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } },
    }));
    expect(mockPushDb.removeByUserEndpointPrefix).not.toHaveBeenCalled();
    expect(mockPushDb.upsert).toHaveBeenCalledWith("louis", "https://web.push.apple.com/abc", "p", "a");
  });
});

describe("DELETE /api/push/subscribe", () => {
  it("returns 401 without a valid session", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { DELETE } = await import("@/app/api/push/subscribe/route");
    const res = await DELETE(fakeReq({ body: {} }));
    expect(res.status).toBe(401);
  });

  it("removes a specific endpoint when provided — the caller's own only", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { DELETE } = await import("@/app/api/push/subscribe/route");
    await DELETE(fakeReq({ cookie: "t", body: { endpoint: "https://push.example/ep" } }));
    // Sans condition sur le compte, qui connaissait l'adresse coupait les notifications d'un autre.
    expect(mockPushDb.removeForUser).toHaveBeenCalledWith("louis", "https://push.example/ep");
    expect(mockPushDb.remove).not.toHaveBeenCalled();
    expect(mockPushDb.removeByUser).not.toHaveBeenCalled();
  });

  it("removes all subscriptions for the user when no endpoint is provided", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { DELETE } = await import("@/app/api/push/subscribe/route");
    await DELETE(fakeReq({ cookie: "t", body: {} }));
    expect(mockPushDb.removeByUser).toHaveBeenCalledWith("louis");
    expect(mockPushDb.remove).not.toHaveBeenCalled();
  });
});
