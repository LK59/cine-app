import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/** Le contrôle de la bibliothèque (DECISIONS.md §90) : administrateur seul, lecture comprise. */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session", SESSION_MAX_AGE: 604800, shouldRefresh: () => false, refreshSessionToken: async () => "r" }));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

function req(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers({ "sec-fetch-site": "same-origin" }), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ u: "mathis", role: "user" });
});

describe("proxy — contrôle de la bibliothèque", () => {
  it("refuse à un compte ordinaire la lecture, l'analyse et l'exception par série", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/admin/library-check"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/admin/library-check"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/admin/library-check/trust"))).status).toBe(403);
    mockVerify.mockResolvedValue({ u: "louis", role: "admin" });
    expect((await proxy(req("GET", "/api/admin/library-check"))).status).toBe(200);
    expect((await proxy(req("POST", "/api/admin/library-check/trust"))).status).toBe(200);
  });
});
