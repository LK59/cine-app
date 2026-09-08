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
vi.mock("@/lib/statusCron", () => ({ POLL_INTERVAL_MS: 60_000 }));

function fakeReq(): NextRequest {
  return {} as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitAllows = true;
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
});
