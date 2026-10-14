import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/** Le proxy et la recherche de répliques (DECISIONS.md §88) : l'indexation à l'administrateur, la recherche à tous. */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session", SESSION_MAX_AGE: 604800, shouldRefresh: () => false, refreshSessionToken: async () => "r" }));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

function req(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ u: "mathis", role: "user" });
});

describe("proxy — répliques", () => {
  it("réserve l'état et les gestes de l'indexation à l'administrateur", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/repliques/admin"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/repliques/admin"))).status).toBe(403);
    mockVerify.mockResolvedValue({ u: "louis", role: "admin" });
    expect((await proxy(req("GET", "/api/repliques/admin"))).status).toBe(200);
    expect((await proxy(req("POST", "/api/repliques/admin"))).status).toBe(200);
  });

  it("laisse chercher tout compte connecté", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/repliques?q=je%20suis%20ton%20pere"))).status).toBe(200);
  });
});
