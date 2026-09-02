import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockCancelTrailerJob = vi.fn();
vi.mock("@/lib/trailerJob", () => ({ cancelTrailerJob: (...a: unknown[]) => mockCancelTrailerJob(...a) }));

function fakeReq(cookie = "t"): NextRequest {
  return { cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/admin/trailers/cancel", () => {
  it("returns 401 for a non-admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "guest" });
    const { POST } = await import("@/app/api/admin/trailers/cancel/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(401);
    expect(mockCancelTrailerJob).not.toHaveBeenCalled();
  });

  it("cancels the job for an admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    const { POST } = await import("@/app/api/admin/trailers/cancel/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(200);
    expect(mockCancelTrailerJob).toHaveBeenCalledTimes(1);
  });
});
