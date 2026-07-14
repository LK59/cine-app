import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({
  verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args),
}));

const mockPushDb = {
  upsert: vi.fn(),
  remove: vi.fn(),
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
      body: { endpoint: "https://push.example/ep", keys: { p256dh: "p", auth: "a" } },
    }));
    expect(res.status).toBe(200);
    expect(mockPushDb.upsert).toHaveBeenCalledWith("louis", "https://push.example/ep", "p", "a");
  });

  it("clears prior Apple Web Push subscriptions for the user before storing a new one", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { POST } = await import("@/app/api/push/subscribe/route");
    await POST(fakeReq({
      cookie: "t",
      body: { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } },
    }));
    expect(mockPushDb.removeByUserEndpointPrefix).toHaveBeenCalledWith("louis", "https://web.push.apple.com/");
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

  it("removes a specific endpoint when provided", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis" });
    const { DELETE } = await import("@/app/api/push/subscribe/route");
    await DELETE(fakeReq({ cookie: "t", body: { endpoint: "https://push.example/ep" } }));
    expect(mockPushDb.remove).toHaveBeenCalledWith("https://push.example/ep");
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
