import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// DECISIONS.md §64 — chaque rapport de la page fait taire le relais du serveur pour ce titre et ce
// compte : `playing`, `progress` et `stop`, les trois routes que les lecteurs appellent.

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => ({ u: "louis", jfId: "jf-1", jfToken: "tok" }) }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { reportPlaybackStart: vi.fn(async () => {}), reportPlaybackProgress: vi.fn(async () => {}), reportPlaybackStopped: vi.fn(async () => {}) },
}));
vi.mock("@/lib/db", () => ({ sessionDb: { jfDevice: () => null }, maintenanceDb: { get: () => null } }));
vi.mock("@/lib/config", () => ({ config: { get player() { return { enabled: true }; } } }));
const notePageReport = vi.fn();
vi.mock("@/lib/castProgress", () => ({ castProgressRelay: () => ({ notePageReport, noteCastSegment: vi.fn() }) }));

const itemId = "0123456789abcdef0123456789abcdef";
function req(): NextRequest {
  return {
    cookies: { get: () => ({ value: "t" }) },
    json: async () => ({ itemId, playSessionId: "s", mediaSourceId: "m", positionTicks: 10 }),
    headers: new Headers(),
  } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("les rapports de la page", () => {
  const routes = {
    playing: () => import("@/app/api/jellyfin/playback/playing/route"),
    progress: () => import("@/app/api/jellyfin/playback/progress/route"),
    stop: () => import("@/app/api/jellyfin/playback/stop/route"),
  };
  it.each(Object.keys(routes) as (keyof typeof routes)[])("%s : le relais se tait pour ce compte et ce titre", async (route) => {
    const { POST } = await routes[route]();
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(notePageReport).toHaveBeenCalledWith("jf-1", itemId);
  });
});
