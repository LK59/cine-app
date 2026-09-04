import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockCheckWatchlistAvailability = vi.fn();
const mockCheckNewEpisodes = vi.fn();
vi.mock("@/lib/notificationJobs", () => ({
  checkWatchlistAvailability: () => mockCheckWatchlistAvailability(),
  checkNewEpisodes: () => mockCheckNewEpisodes(),
}));

function fakeReq(cookie = "t"): NextRequest {
  return { cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/notifications/check", () => {
  it("returns 401 for a non-admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "user" });
    const { POST } = await import("@/app/api/admin/notifications/check/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(401);
    expect(mockCheckWatchlistAvailability).not.toHaveBeenCalled();
  });

  it("returns 401 when session verification throws", async () => {
    mockVerifySessionFull.mockRejectedValue(new Error("bad token"));
    const { POST } = await import("@/app/api/admin/notifications/check/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(401);
  });

  it("runs both notification checks for an admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    const { POST } = await import("@/app/api/admin/notifications/check/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(200);
    expect(mockCheckWatchlistAvailability).toHaveBeenCalledTimes(1);
    expect(mockCheckNewEpisodes).toHaveBeenCalledTimes(1);
  });
});
