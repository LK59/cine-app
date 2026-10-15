import { describe, it, expect, vi, afterEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Le compteur des connexions, le vrai, derrière la vraie route (15/10/2026, passe de nuit, BUREAU-2).
 *
 * Il comptait chaque tentative, réussites comprises : dix appareils d'un même foyer connectés dans
 * le quart d'heure, et la onzième connexion — avec le bon mot de passe — répondait 429, en français.
 */
vi.mock("@/lib/config", () => ({
  config: {
    jellyfin: { url: "http://jellyfin.local" },
    jellyseerr: { url: "http://jellyseerr.local", apiKey: "" },
    app: { cookieSecure: false, language: "fr" },
  },
}));
vi.mock("@/lib/auth", () => ({
  createSessionToken: async () => ({ token: "signed-token", jti: "jti-1" }),
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 3600,
}));
vi.mock("@/lib/db", () => ({ sessionDb: { create: () => [] }, userPrefsDb: { getLang: () => "fr" } }));
vi.mock("@/lib/i18n", () => ({ LOCALE_COOKIE: "cine-lang" }));
vi.mock("@/lib/api-helpers", () => ({ getClientIp: () => "192.0.2.77" }));
vi.mock("@/lib/eventLogs", () => ({ logAuthEvent: () => {} }));

function fakeReq(): NextRequest {
  return {
    json: async () => ({ username: "louis", password: "x" }),
    headers: new Headers({ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0" }),
  } as unknown as NextRequest;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("POST /api/auth/jellyfin — le compteur", () => {
  it("ne compte pas les connexions réussies, mais compte les échecs", async () => {
    const { POST } = await import("@/app/api/auth/jellyfin/route");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ User: { Name: "louis", Id: "jf-1", Policy: {} }, AccessToken: "jf-token" }),
    });
    for (let i = 0; i < 12; i++) expect((await POST(fakeReq())).status, `connexion ${i + 1}`).toBe(200);

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    for (let i = 0; i < 10; i++) expect((await POST(fakeReq())).status, `échec ${i + 1}`).toBe(401);
    const refused = await POST(fakeReq());
    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body.code).toBe("rate_limited");
    expect(body.retryAfterS).toBeGreaterThan(0);
  });
});
