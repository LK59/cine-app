import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockCheckRateLimit = vi.fn(() => true);
vi.mock("@/lib/rateLimiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockSessionDb = { create: vi.fn(), delete: vi.fn() };
const mockUserPrefsDb = { getLang: vi.fn(() => "fr") };
vi.mock("@/lib/db", () => ({
  sessionDb: mockSessionDb,
  userPrefsDb: mockUserPrefsDb,
}));

vi.mock("@/lib/config", () => ({
  config: {
    app: { adminUser: "admin", adminPassword: "secret", sessionSecret: "test-secret", cookieSecure: false, language: "fr" },
  },
}));

function fakeReq(opts: { body?: unknown; cookie?: string; ip?: string }): NextRequest {
  return {
    headers: { get: (name: string) => (name === "x-forwarded-for" ? (opts.ip ?? "1.2.3.4") : null) },
    cookies: { get: (name: string) => (name === "cine_session" && opts.cookie ? { value: opts.cookie } : undefined) },
    json: async () => opts.body ?? null,
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue(true);
});

describe("POST /api/auth/login", () => {
  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockReturnValue(false);
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(fakeReq({ body: { username: "admin", password: "secret" } }));
    expect(res.status).toBe(429);
  });

  it("returns 400 when credentials are missing", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(fakeReq({ body: { username: "admin" } }));
    expect(res.status).toBe(400);
  });

  it("returns 401 for wrong password", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(fakeReq({ body: { username: "admin", password: "wrong" } }));
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong username", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(fakeReq({ body: { username: "someone", password: "secret" } }));
    expect(res.status).toBe(401);
  });

  it("logs in successfully with correct admin credentials and sets cookies", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(fakeReq({ body: { username: "admin", password: "secret" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.role).toBe("admin");
    expect(mockSessionDb.create).toHaveBeenCalledTimes(1);
    expect(res.cookies.get("cine_session")?.value).toBeTruthy();
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST(fakeReq({}));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(res.cookies.get("cine_session")?.value).toBe("");
  });

  it("revokes the session server-side by extracting jti from the token", async () => {
    const { createSessionToken } = await import("@/lib/auth");
    const { token, jti } = await createSessionToken("louis", "admin");
    const { POST } = await import("@/app/api/auth/logout/route");
    await POST(fakeReq({ cookie: token }));
    expect(mockSessionDb.delete).toHaveBeenCalledWith(jti);
  });

  it("does not throw when the cookie is garbage", async () => {
    const { POST } = await import("@/app/api/auth/logout/route");
    const res = await POST(fakeReq({ cookie: "not-a-valid-token" }));
    expect(res.status).toBe(200);
    expect(mockSessionDb.delete).not.toHaveBeenCalled();
  });
});
