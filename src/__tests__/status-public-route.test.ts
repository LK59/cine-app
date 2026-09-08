import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

let rateLimitAllows = true;
vi.mock("@/lib/rateLimiter", () => ({
  createRateLimiter: () => () => rateLimitAllows,
}));
vi.mock("@/lib/api-helpers", () => ({ getClientIp: () => "1.2.3.4" }));

const runAllServiceChecks = vi.fn(async () => ({}));
const computeCapabilities = vi.fn(() => [
  { id: "lecture", status: "ok" as const, note: null, dependsOn: [], softDependsOn: [] },
]);
vi.mock("@/lib/healthChecks", () => ({
  runAllServiceChecks: () => runAllServiceChecks(),
  computeCapabilities: () => computeCapabilities(),
}));

const getCapabilityHistory = vi.fn(() => []);
vi.mock("@/lib/db", () => ({ statusHistoryDb: { getCapabilityHistory: () => getCapabilityHistory() } }));
vi.mock("@/lib/statusHistory", () => ({ analyzeHistory: () => ({ uptimePct: 100, incidents: [] }) }));

let snapshot: { capabilities: { id: string; status: "ok"; note: null; dependsOn: []; softDependsOn: [] }[]; checkedAt: number } | null = null;
vi.mock("@/lib/statusCron", () => ({
  POLL_INTERVAL_MS: 60_000,
  getLastStatusSnapshot: () => snapshot,
}));

function fakeReq(search = ""): NextRequest {
  return { nextUrl: new URL(`http://x/api/status/public${search}`) } as unknown as NextRequest;
}

function freshSnapshot(ageMs: number) {
  return {
    capabilities: [{ id: "lecture", status: "ok" as const, note: null, dependsOn: [] as [], softDependsOn: [] as [] }],
    checkedAt: Date.now() - ageMs,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Le cache d'historique est un état de module : sans ça, un test lirait la réponse du précédent.
  vi.resetModules();
  rateLimitAllows = true;
  snapshot = null;
});

describe("GET /api/status/public", () => {
  it("returns the capability payload when the IP is under the limit", async () => {
    const { GET } = await import("@/app/api/status/public/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overall).toBe("ok");
    expect(body.capabilities).toHaveLength(1);
  });

  // La borne doit précéder le travail, pas le suivre : ce qu'on protège, ce sont les ~330 ms de
  // SQLite synchrone et les douze appels amont. Un 429 rendu après les avoir payés ne protège rien.
  it("returns 429 without touching the services or the database when rate limited", async () => {
    rateLimitAllows = false;
    const { GET } = await import("@/app/api/status/public/route");
    const res = await GET(fakeReq());
    expect(res.status).toBe(429);
    expect(runAllServiceChecks).not.toHaveBeenCalled();
    expect(getCapabilityHistory).not.toHaveBeenCalled();
  });

  // Le point de tout le changement : une ouverture ordinaire de /status ne doit plus rien coûter
  // en amont, et doit dater la donnée du relevé, pas de la requête.
  it("serves the last poll without calling the upstream services", async () => {
    snapshot = freshSnapshot(30_000);
    const { GET } = await import("@/app/api/status/public/route");
    const body = await (await GET(fakeReq())).json();
    expect(runAllServiceChecks).not.toHaveBeenCalled();
    expect(body.live).toBe(false);
    expect(body.checkedAt).toBe(new Date(snapshot.checkedAt).toISOString());
  });

  it("recomputes everything when ?refresh=1 asks for it", async () => {
    snapshot = freshSnapshot(30_000);
    const { GET } = await import("@/app/api/status/public/route");
    const body = await (await GET(fakeReq("?refresh=1"))).json();
    expect(runAllServiceChecks).toHaveBeenCalledTimes(1);
    expect(body.live).toBe(true);
  });

  // /status est la page de secours : elle doit répondre quelque chose de vrai même quand c'est le
  // relevé lui-même qui ne tourne pas — jamais une page vide.
  it("falls back to a live check when no poll has ever run", async () => {
    const { GET } = await import("@/app/api/status/public/route");
    const body = await (await GET(fakeReq())).json();
    expect(runAllServiceChecks).toHaveBeenCalledTimes(1);
    expect(body.live).toBe(true);
    expect(body.capabilities).toHaveLength(1);
  });

  it("falls back to a live check when the last poll is too old", async () => {
    snapshot = freshSnapshot(4 * 60_000);
    const { GET } = await import("@/app/api/status/public/route");
    const body = await (await GET(fakeReq())).json();
    expect(runAllServiceChecks).toHaveBeenCalledTimes(1);
    expect(body.live).toBe(true);
  });

  // Les 393 000 lignes de l'historique ne bougent qu'au relevé : deux requêtes entre deux passages
  // doivent se partager une seule lecture SQL, sinon la borne reste le seul rempart.
  it("reads the seven-day history once per poll, not once per request", async () => {
    snapshot = freshSnapshot(10_000);
    const { GET } = await import("@/app/api/status/public/route");
    await GET(fakeReq());
    await GET(fakeReq());
    await GET(fakeReq("?refresh=1"));
    expect(getCapabilityHistory).toHaveBeenCalledTimes(1);
  });
});
