import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/config", () => ({
  config: { app: { language: "fr" }, player: { enabled: true } },
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockInvalidateLibrary = vi.fn();
vi.mock("@/lib/server-cache", () => ({ invalidateLibrary: () => mockInvalidateLibrary() }));

function fakeReq(cookie = "t"): NextRequest {
  return { cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/config/public", () => {
  it("exposes only defaultLang and playerEnabled", async () => {
    const { GET } = await import("@/app/api/config/public/route");
    const body = await (await GET()).json();
    expect(body).toEqual({ defaultLang: "fr", playerEnabled: true });
  });
});

describe("POST /api/cache/invalidate", () => {
  it("returns 403 for a non-admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "user" });
    const { POST } = await import("@/app/api/cache/invalidate/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(403);
    expect(mockInvalidateLibrary).not.toHaveBeenCalled();
  });

  it("invalidates the library cache for an admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    const { POST } = await import("@/app/api/cache/invalidate/route");
    const res = await POST(fakeReq());
    expect((await res.json()).ok).toBe(true);
    expect(mockInvalidateLibrary).toHaveBeenCalled();
  });
});
