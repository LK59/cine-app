import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * L'analyse de la bibliothèque en fond vue de la Configuration (DECISIONS.md §138, planificateur) :
 * `/api/admin/xray/scan` est à l'administrateur seul, lecture comprise — le proxy (`ADMIN_ONLY_READS`,
 * `/api/admin/xray`) et la route (`adminOnly`) refusent tout autre compte ; un geste inconnu est refusé.
 */

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const mockAction = vi.fn(async () => undefined);
vi.mock("@/lib/xray/scheduler", () => ({
  xrayScanStatus: () => ({ configured: true, phase: "running", tiers: [] }),
  scanAction: (...a: unknown[]) => mockAction(...(a as [])),
}));

function proxyReq(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}
function routeReq(body: unknown): NextRequest {
  return { cookies: { get: () => ({ value: "t" }) }, nextUrl: new URL("https://cine.example/api/admin/xray/scan"), json: async () => body } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("le proxy", () => {
  it("refuse la lecture et les gestes à un compte ordinaire, les laisse à l'administrateur", async () => {
    const { proxy } = await import("@/proxy");
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    expect((await proxy(proxyReq("GET", "/api/admin/xray/scan"))).status).toBe(403);
    expect((await proxy(proxyReq("POST", "/api/admin/xray/scan"))).status).toBe(403);
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    expect((await proxy(proxyReq("GET", "/api/admin/xray/scan"))).status).toBe(200);
    expect((await proxy(proxyReq("POST", "/api/admin/xray/scan"))).status).toBe(200);
  });

  it("la page de la Configuration est à l'administrateur", async () => {
    const { isAdminOnlyPage } = await import("@/proxy");
    expect(isAdminOnlyPage("/parametres/acteurs")).toBe(true);
  });
});

describe("la route", () => {
  it("refuse tout compte qui n'est pas administrateur", async () => {
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    const { GET, POST } = await import("@/app/api/admin/xray/scan/route");
    expect((await GET(routeReq(null))).status).toBe(403);
    expect((await POST(routeReq({ action: "run", tier: 1 }))).status).toBe(403);
    expect(mockAction).not.toHaveBeenCalled();
  });

  it("l'administrateur : gestes et paliers vérifiés", async () => {
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    const { GET, POST } = await import("@/app/api/admin/xray/scan/route");
    expect((await GET(routeReq(null))).status).toBe(200);
    expect((await POST(routeReq({ action: "run", tier: 1 }))).status).toBe(200);
    expect(mockAction).toHaveBeenCalledWith("run", 1);
    expect((await POST(routeReq({ action: "pause" }))).status).toBe(200);
    expect(mockAction).toHaveBeenLastCalledWith("pause", null);
    expect((await POST(routeReq({ action: "effacer" }))).status).toBe(400);
    expect((await POST(routeReq({ action: "run", tier: 4 }))).status).toBe(400);
  });
});
