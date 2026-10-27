import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Le proxy et le Stream Deck (27/10/2026) : `/api/streamdeck` passe sans session — la route vérifie
 * son jeton — ; la gestion des jetons reste à l'administrateur.
 */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session", SESSION_MAX_AGE: 604800, shouldRefresh: () => false, refreshSessionToken: async () => "r" }));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));

function proxyReq(method: string, pathname: string, cookie = true): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "sec-fetch-site": "same-origin" }),
    cookies: { get: () => (cookie ? { value: "t" } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  verify.mockReset();
});

describe("proxy — Stream Deck", () => {
  it("les lectures en cours passent sans session jusqu'à la route", async () => {
    verify.mockResolvedValue(null);
    const { proxy } = await import("@/proxy");
    expect((await proxy(proxyReq("GET", "/api/streamdeck/plays", false))).status).toBe(200);
    expect((await proxy(proxyReq("GET", "/api/streamdeck/image", false))).status).toBe(200);
  });

  it("un compte ordinaire ne crée ni ne révoque de jeton", async () => {
    verify.mockResolvedValue({ u: "mathis", role: "user", jti: "j", exp: Date.now() / 1000 + 3600 });
    const { proxy } = await import("@/proxy");
    expect((await proxy(proxyReq("POST", "/api/admin/streamdeck/tokens"))).status).toBe(403);
    expect((await proxy(proxyReq("DELETE", "/api/admin/streamdeck/tokens?id=0123456789abcdef"))).status).toBe(403);
  });
});
