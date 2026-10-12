import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// La route d'arrêt, marquée `late` (DECISIONS.md §78) : une position gardée sur l'appareil pendant une
// coupure, rendue par la règle des bilans perdus — jamais un arrêt de séance.

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
let account = "jf-1";
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => ({ u: "louis", jfId: account, jfToken: "tok" }) }));
const reportPlaybackStopped = vi.fn(async () => {});
const stopTranscode = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { reportPlaybackStopped, stopTranscode: (...args: unknown[]) => stopTranscode(...args) } }));
vi.mock("@/lib/db", () => ({ sessionDb: { jfDevice: () => null }, maintenanceDb: { get: () => null } }));
vi.mock("@/lib/config", () => ({ config: { get player() { return { enabled: true }; } } }));
vi.mock("@/lib/castProgress", () => ({ castProgressRelay: () => ({ notePageReport: vi.fn(), noteCastSegment: vi.fn() }) }));
const recoverLostPosition = vi.fn(async (..._args: unknown[]) => "avancée de 27 s");
vi.mock("@/lib/lostStopPosition", () => ({ recoverLostPosition: (...args: unknown[]) => recoverLostPosition(...args) }));

const itemId = "0123456789abcdef0123456789abcdef";
const req = (body: Record<string, unknown>) =>
  ({ cookies: { get: () => ({ value: "t" }) }, json: async () => body, headers: new Headers() }) as unknown as NextRequest;

beforeEach(async () => {
  vi.clearAllMocks();
  account = "jf-1";
  (await import("@/lib/prewarmSessions")).forgetPrewarmSessions();
});

describe("une position renvoyée après une coupure", () => {
  it("passe par la règle des bilans perdus, sans arrêter de séance", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    const res = await POST(req({ itemId, positionTicks: 2421 * 10_000_000, late: true, lateByMs: 60_000 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "avancée de 27 s" });
    expect(recoverLostPosition).toHaveBeenCalledWith("jf-1", { why: "lost", itemId, at: 2421, lateByMs: 60_000 }, expect.any(Number));
    expect(reportPlaybackStopped).not.toHaveBeenCalled();
  });

  it("refusée sans titre valide ou sans position", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    expect((await POST(req({ itemId: "../x", positionTicks: 10, late: true, lateByMs: 1 }))).status).toBe(400);
    expect((await POST(req({ itemId, positionTicks: 0, late: true, lateByMs: 1 }))).status).toBe(400);
  });
});

describe("un préchauffage abandonné (§78)", () => {
  it("arrête le transcodage par son appareil et sa séance — aucune position écrite, aucun arrêt annoncé", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    (await import("@/lib/prewarmSessions")).notePrewarmSession("jf-1", "ps-1", "dev-1");
    const res = await POST(req({ itemId, playSessionId: "ps-1", mediaSourceId: "ms-1", deviceId: "dev-1", prewarm: true }));
    expect(res.status).toBe(200);
    expect(stopTranscode).toHaveBeenCalledWith("dev-1", "ps-1");
    expect(reportPlaybackStopped).not.toHaveBeenCalled();
    expect(recoverLostPosition).not.toHaveBeenCalled();
  });

  it("refusé avec des identifiants qui ne sont pas des identifiants", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    expect((await POST(req({ itemId, playSessionId: "a&b", mediaSourceId: "m", deviceId: "dev-1", prewarm: true }))).status).toBe(400);
    expect(stopTranscode).not.toHaveBeenCalled();
  });

  it("seulement une séance de préchauffage ouverte pour ce compte, sous cet appareil — jamais celle d'un autre, ni une séance quelconque", async () => {
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    const { notePrewarmSession } = await import("@/lib/prewarmSessions");
    notePrewarmSession("jf-2", "ps-autre", "dev-2");
    // Un autre compte, une séance jamais préchauffée, un autre appareil : refusés.
    expect((await POST(req({ itemId, playSessionId: "ps-autre", mediaSourceId: "m", deviceId: "dev-2", prewarm: true }))).status).toBe(404);
    expect((await POST(req({ itemId, playSessionId: "ps-quelconque", mediaSourceId: "m", deviceId: "dev-1", prewarm: true }))).status).toBe(404);
    account = "jf-2";
    expect((await POST(req({ itemId, playSessionId: "ps-autre", mediaSourceId: "m", deviceId: "dev-1", prewarm: true }))).status).toBe(404);
    expect(stopTranscode).not.toHaveBeenCalled();
    // Le sien : arrêté, une fois.
    expect((await POST(req({ itemId, playSessionId: "ps-autre", mediaSourceId: "m", deviceId: "dev-2", prewarm: true }))).status).toBe(200);
    expect(stopTranscode).toHaveBeenCalledWith("dev-2", "ps-autre");
    expect((await POST(req({ itemId, playSessionId: "ps-autre", mediaSourceId: "m", deviceId: "dev-2", prewarm: true }))).status).toBe(404);
  });
});
