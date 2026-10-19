import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Les téléchargements vus de l'activité (19/10/2026) : la liste des versions du serveur et leur
 * effacement sont à l'administrateur seul — refusés par la route elle-même, et par `proxy.ts`
 * (lecture dans `ADMIN_ONLY_READS`, effacement absent de la liste blanche des écritures).
 */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session", SESSION_MAX_AGE: 604800, shouldRefresh: () => false, refreshSessionToken: async () => "r" }));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
const overview = vi.fn();
vi.mock("@/lib/activity/offlineDownloads", () => ({ downloadsOverview: (...a: unknown[]) => overview(...a) }));
const del = vi.fn();
vi.mock("@/lib/offline/jobs", () => ({ deleteOfflineCopy: (...a: unknown[]) => del(...a) }));

import { GET } from "@/app/api/admin/offline/route";
import { DELETE } from "@/app/api/admin/offline/[jobId]/route";

const JOB = "c".repeat(32);
const routeReq = () => ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers() }) as unknown as NextRequest;
const params = (jobId = JOB) => ({ params: Promise.resolve({ jobId }) });
function proxyReq(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers({ "sec-fetch-site": "same-origin" }), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  verify.mockResolvedValue({ u: "mathis", role: "user" });
  overview.mockResolvedValue({ now: 1, copies: [], events: [], totals: {} });
  del.mockReturnValue(true);
});

describe("GET /api/admin/offline", () => {
  it("403 à un compte ordinaire, sans rien lire", async () => {
    expect((await GET(routeReq())).status).toBe(403);
    expect(overview).not.toHaveBeenCalled();
  });
  it("l'administrateur reçoit les versions et les gestes", async () => {
    verify.mockResolvedValue({ u: "louis", role: "admin" });
    const res = await GET(routeReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ copies: [], events: [] });
  });
});

describe("DELETE /api/admin/offline/:id", () => {
  it("403 à un compte ordinaire ; l'administrateur efface, à son nom", async () => {
    expect((await DELETE(routeReq(), params())).status).toBe(403);
    expect(del).not.toHaveBeenCalled();
    verify.mockResolvedValue({ u: "louis", role: "admin" });
    expect((await DELETE(routeReq(), params())).status).toBe(200);
    expect(del).toHaveBeenCalledWith(JOB, "louis");
    del.mockReturnValue(false);
    expect((await DELETE(routeReq(), params())).status).toBe(404);
    expect((await DELETE(routeReq(), params("../x"))).status).toBe(400);
  });
});

describe("proxy — téléchargements de l'activité", () => {
  it("refuse la lecture et l'effacement à un compte ordinaire, garde sa propre demande ouverte", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(proxyReq("GET", "/api/admin/offline"))).status).toBe(403);
    expect((await proxy(proxyReq("DELETE", `/api/admin/offline/${JOB}`))).status).toBe(403);
    // Retirer sa propre demande reste permis (liste blanche) : ce n'est pas la même route.
    expect((await proxy(proxyReq("DELETE", `/api/offline/jobs/${JOB}`))).status).toBe(200);
    verify.mockResolvedValue({ u: "louis", role: "admin" });
    expect((await proxy(proxyReq("GET", "/api/admin/offline"))).status).toBe(200);
    expect((await proxy(proxyReq("DELETE", `/api/admin/offline/${JOB}`))).status).toBe(200);
  });
});
