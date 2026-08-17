import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/config", () => ({
  config: {
    jellyfin: { url: "http://jellyfin.local" },
    jellyseerr: { url: "http://jellyseerr.local", apiKey: "seerr-key" },
    app: { cookieSecure: false, language: "fr" },
  },
}));
const mockJellyseerrLogin = vi.fn();
vi.mock("@/lib/clients/jellyseerr", () => ({
  jellyseerr: { login: (...args: unknown[]) => mockJellyseerrLogin(...args) },
}));
const mockCreateSessionToken = vi.fn();
vi.mock("@/lib/auth", () => ({
  createSessionToken: (...args: unknown[]) => mockCreateSessionToken(...args),
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 3600,
}));
const mockSessionDb = { create: vi.fn() };
const mockUserPrefsDb = { getLang: vi.fn() };
vi.mock("@/lib/db", () => ({ sessionDb: mockSessionDb, userPrefsDb: mockUserPrefsDb }));
let rateLimitOk = true;
vi.mock("@/lib/rateLimiter", () => ({ checkRateLimit: () => rateLimitOk }));
vi.mock("@/lib/i18n", () => ({ LOCALE_COOKIE: "cine-lang" }));
vi.mock("@/lib/api-helpers", () => ({ getClientIp: () => "1.2.3.4" }));

function fakeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitOk = true;
  mockCreateSessionToken.mockResolvedValue({ token: "signed-token", jti: "jti-1" });
  mockUserPrefsDb.getLang.mockReturnValue("fr");
  mockJellyseerrLogin.mockResolvedValue(null);
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("POST /api/auth/jellyfin", () => {
  it("returns 429 when the IP is rate-limited", async () => {
    rateLimitOk = false;
    const { POST } = await import("@/app/api/auth/jellyfin/route");
    const res = await POST(fakeReq({ username: "louis", password: "x" }));
    expect(res.status).toBe(429);
  });

  it("returns 400 when username or password is missing", async () => {
    const { POST } = await import("@/app/api/auth/jellyfin/route");
    const res = await POST(fakeReq({ username: "louis" }));
    expect(res.status).toBe(400);
  });

  it("returns 502 when Jellyfin cannot be reached", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { POST } = await import("@/app/api/auth/jellyfin/route");
    const res = await POST(fakeReq({ username: "louis", password: "x" }));
    expect(res.status).toBe(502);
  });

  it("returns 401 when Jellyfin rejects the credentials", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const { POST } = await import("@/app/api/auth/jellyfin/route");
    const res = await POST(fakeReq({ username: "louis", password: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("maps Jellyfin's IsAdministrator policy to the admin role and sets a session cookie", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        User: { Name: "louis", Id: "jf-1", Policy: { IsAdministrator: true } },
        AccessToken: "jf-token",
      }),
    });

    const { POST } = await import("@/app/api/auth/jellyfin/route");
    const res = await POST(fakeReq({ username: "louis", password: "x" }));
    const body = await res.json();

    expect(body).toEqual({ ok: true, role: "admin" });
    expect(mockJellyseerrLogin).toHaveBeenCalledWith("louis", "x");
    expect(mockCreateSessionToken).toHaveBeenCalledWith("louis", "admin", "louis", "jf-1", "jf-token", undefined);
    expect(mockSessionDb.create).toHaveBeenCalledWith("jti-1", "jf-1");
    expect(res.cookies.get("cine_session")?.value).toBe("signed-token");
  });

  it("also logs into Jellyseerr with the same credentials and carries its session cookie", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        User: { Name: "louis", Id: "jf-1", Policy: { IsAdministrator: true } },
        AccessToken: "jf-token",
      }),
    });
    mockJellyseerrLogin.mockResolvedValue("s%3Aabc123.signature");

    const { POST } = await import("@/app/api/auth/jellyfin/route");
    await POST(fakeReq({ username: "louis", password: "x" }));

    expect(mockCreateSessionToken).toHaveBeenCalledWith(
      "louis", "admin", "louis", "jf-1", "jf-token", "s%3Aabc123.signature"
    );
  });

  it("maps a non-administrator Jellyfin user to the guest role", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        User: { Name: "guest1", Id: "jf-2", Policy: { IsAdministrator: false } },
        AccessToken: "tok",
      }),
    });

    const { POST } = await import("@/app/api/auth/jellyfin/route");
    const res = await POST(fakeReq({ username: "guest1", password: "x" }));
    const body = await res.json();
    expect(body.role).toBe("guest");
  });
});
