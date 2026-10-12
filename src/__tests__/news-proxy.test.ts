import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/** Le proxy et les Nouveautés (DECISIONS.md §73) : ce qu'un compte ordinaire peut faire, et pas. */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session", SESSION_MAX_AGE: 604800, shouldRefresh: () => false, refreshSessionToken: async () => "r" }));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

function req(method: string, pathname: string, headers: Record<string, string> = {}): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(headers), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ u: "mathis", role: "user" });
});

describe("proxy — Nouveautés", () => {
  it("laisse un compte ordinaire lire ses nouveautés, les marquer vues et envoyer ses mesures", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/release-notes"))).status).toBe(200);
    expect((await proxy(req("POST", "/api/release-notes/seen"))).status).toBe(200);
    expect((await proxy(req("POST", "/api/release-notes/event"))).status).toBe(200);
  });

  it("réserve à l'administrateur l'état des comptes, l'éditeur, la traduction et la relance — lecture comprise", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/admin/release-notes"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/admin/release-notes"))).status).toBe(403);
    expect((await proxy(req("PUT", "/api/admin/release-notes/3"))).status).toBe(403);
    expect((await proxy(req("DELETE", "/api/admin/release-notes/3"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/admin/release-notes/3/publish"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/admin/release-notes/translate"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/admin/release-notes/relaunch"))).status).toBe(403);
    mockVerify.mockResolvedValue({ u: "louis", role: "admin" });
    expect((await proxy(req("GET", "/api/admin/release-notes"))).status).toBe(200);
    expect((await proxy(req("POST", "/api/admin/release-notes/relaunch"))).status).toBe(200);
  });

  it("refuse une mesure venue d'un autre site", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("POST", "/api/release-notes/event", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });
});
