import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/** Le proxy et les sous-titres générés (DECISIONS.md §69) : ce qu'un compte ordinaire peut faire. */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session", SESSION_MAX_AGE: 604800, shouldRefresh: () => false, refreshSessionToken: async () => "r" }));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

function req(method: string, pathname: string, headers: Record<string, string> = {}): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(headers), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}
const JOB = "0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ u: "mathis", role: "user" });
});

describe("proxy — sous-titres générés", () => {
  it("laisse un compte ordinaire lancer, sonder et reprendre", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/subtitle-gen/options?itemId=x"))).status).toBe(200);
    expect((await proxy(req("POST", "/api/subtitle-gen/jobs"))).status).toBe(200);
    expect((await proxy(req("POST", `/api/subtitle-gen/jobs/${JOB}/poll`))).status).toBe(200);
    expect((await proxy(req("POST", `/api/subtitle-gen/jobs/${JOB}/resume`))).status).toBe(200);
    expect((await proxy(req("GET", `/api/subtitle-gen/files/${JOB}.vtt`))).status).toBe(200);
  });

  it("garde les motifs étroits", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("POST", "/api/subtitle-gen/jobs/abc/poll"))).status).toBe(403);
    expect((await proxy(req("POST", `/api/subtitle-gen/jobs/${JOB}/poll/x`))).status).toBe(403);
    expect((await proxy(req("DELETE", `/api/subtitle-gen/jobs/${JOB}`))).status).toBe(403);
  });

  it("réserve à l'administrateur le panneau, l'annulation et les réglages", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/subtitle-gen/admin"))).status).toBe(403);
    expect((await proxy(req("POST", `/api/subtitle-gen/admin/jobs/${JOB}/cancel`))).status).toBe(403);
    expect((await proxy(req("PUT", "/api/settings"))).status).toBe(403);
    mockVerify.mockResolvedValue({ u: "louis", role: "admin" });
    expect((await proxy(req("GET", "/api/subtitle-gen/admin"))).status).toBe(200);
    expect((await proxy(req("POST", `/api/subtitle-gen/admin/jobs/${JOB}/cancel`))).status).toBe(200);
  });

  it("refuse une écriture venue d'un autre site", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("POST", "/api/subtitle-gen/jobs", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });
});
