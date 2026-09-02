import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockGetLatestJob = vi.fn();
const mockSetAutoPreviewEnabled = vi.fn();
vi.mock("@/lib/db", () => ({
  trailerDb: {
    getLatestJob: (...a: unknown[]) => mockGetLatestJob(...a),
    setAutoPreviewEnabled: (...a: unknown[]) => mockSetAutoPreviewEnabled(...a),
  },
}));

function fakeReq(body: unknown, cookie = "t"): NextRequest {
  return {
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    json: async () => body,
  } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/admin/trailers/toggle", () => {
  it("returns 401 for a non-admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "guest" });
    const { POST } = await import("@/app/api/admin/trailers/toggle/route");
    const res = await POST(fakeReq({ enabled: true }));
    expect(res.status).toBe(401);
    expect(mockSetAutoPreviewEnabled).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-boolean body", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    const { POST } = await import("@/app/api/admin/trailers/toggle/route");
    const res = await POST(fakeReq({ enabled: "yes" }));
    expect(res.status).toBe(400);
  });

  it("rejects enabling when no job has ever completed", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    mockGetLatestJob.mockReturnValue(null);
    const { POST } = await import("@/app/api/admin/trailers/toggle/route");
    const res = await POST(fakeReq({ enabled: true }));
    expect(res.status).toBe(400);
    expect(mockSetAutoPreviewEnabled).not.toHaveBeenCalled();
  });

  it("rejects enabling while a job is still running", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    mockGetLatestJob.mockReturnValue({ status: "running" });
    const { POST } = await import("@/app/api/admin/trailers/toggle/route");
    const res = await POST(fakeReq({ enabled: true }));
    expect(res.status).toBe(400);
  });

  it("accepts enabling once a job has completed", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    mockGetLatestJob.mockReturnValue({ status: "done" });
    const { POST } = await import("@/app/api/admin/trailers/toggle/route");
    const res = await POST(fakeReq({ enabled: true }));
    expect(res.status).toBe(200);
    expect(mockSetAutoPreviewEnabled).toHaveBeenCalledWith(true);
  });

  it("always accepts disabling, regardless of job status", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    mockGetLatestJob.mockReturnValue(null);
    const { POST } = await import("@/app/api/admin/trailers/toggle/route");
    const res = await POST(fakeReq({ enabled: false }));
    expect(res.status).toBe(200);
    expect(mockSetAutoPreviewEnabled).toHaveBeenCalledWith(false);
  });
});
