import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Les cinq transcodages simultanés par compte (`transcodeBudget.ts`, revue de sécurité du 20/10/2026) :
// le module lui-même, et la route d'arrêt qui libère une place.

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => ({ u: "louis", jfId: "jf-1", jfToken: "tok" }) }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { reportPlaybackStopped: vi.fn(async () => {}), stopTranscode: vi.fn(async () => {}) } }));
vi.mock("@/lib/db", () => ({ sessionDb: { jfDevice: () => null }, maintenanceDb: { get: () => null } }));
vi.mock("@/lib/config", () => ({ config: { get player() { return { enabled: true }; } } }));
vi.mock("@/lib/castProgress", () => ({ castProgressRelay: () => ({ notePageReport: vi.fn(), noteCastSegment: vi.fn() }) }));
vi.mock("@/lib/playbackReport", () => ({ reportPlayback: async () => NextResponse.json({ ok: true }) }));
vi.mock("@/lib/playbackDevice", () => ({ playbackDevice: () => ({ id: "d", name: "n" }) }));

import { ACTIVE_MS, MAX_ACCOUNTS, TRANSCODE_LIMIT_PER_ACCOUNT, activeTranscodes, admitTranscode, forgetTranscode, resetTranscodeBudget, shouldLogRefusal } from "@/lib/transcodeBudget";

const itemId = "0123456789abcdef0123456789abcdef";
const req = (body: Record<string, unknown>) =>
  ({ cookies: { get: () => ({ value: "t" }) }, json: async () => body, headers: new Headers() }) as unknown as NextRequest;

beforeEach(() => resetTranscodeBudget());

describe("transcodeBudget", () => {
  it("cinq séances par compte ; une séance déjà active passe toujours", () => {
    expect(TRANSCODE_LIMIT_PER_ACCOUNT).toBe(5);
    for (let i = 0; i < 5; i++) expect(admitTranscode("a", `p${i}`, 0)).toBe(true);
    expect(admitTranscode("a", "p5", 0)).toBe(false);
    expect(admitTranscode("a", "p2", 10)).toBe(true);
    expect(admitTranscode("b", "p5", 0)).toBe(true);
    expect(activeTranscodes("a", 10)).toBe(5);
  });

  it("une séance que ses segments font vivre ne s'éteint pas ; une séance muette, si", () => {
    for (let i = 0; i < 5; i++) admitTranscode("a", `p${i}`, 0);
    // p0 continue d'être lue ; les autres se taisent.
    admitTranscode("a", "p0", ACTIVE_MS - 1);
    expect(activeTranscodes("a", ACTIVE_MS + 1)).toBe(1);
    expect(admitTranscode("a", "nouvelle", ACTIVE_MS + 1)).toBe(true);
  });

  it("l'arrêt libère la place", () => {
    for (let i = 0; i < 5; i++) admitTranscode("a", `p${i}`, 0);
    forgetTranscode("a", "p1");
    forgetTranscode(null, "p2");
    forgetTranscode("a", undefined);
    expect(activeTranscodes("a", 0)).toBe(4);
    expect(admitTranscode("a", "p5", 0)).toBe(true);
  });

  it("borné en nombre de comptes, les moins récents partent d'abord", () => {
    for (let i = 0; i <= MAX_ACCOUNTS; i++) admitTranscode(`c${i}`, "p", 0);
    expect(activeTranscodes("c0", 0)).toBe(0);
    expect(activeTranscodes(`c${MAX_ACCOUNTS}`, 0)).toBe(1);
  });

  it("un refus est journalisé au plus une fois par minute et par compte", () => {
    expect(shouldLogRefusal("a", 0)).toBe(true);
    expect(shouldLogRefusal("a", 30_000)).toBe(false);
    expect(shouldLogRefusal("b", 30_000)).toBe(true);
    expect(shouldLogRefusal("a", 60_000)).toBe(true);
  });
});

describe("POST /api/jellyfin/playback/stop", () => {
  it("oublie la séance arrêtée : sa place se libère pour le compte", async () => {
    for (let i = 0; i < 5; i++) admitTranscode("jf-1", `p${i}`);
    expect(admitTranscode("jf-1", "p5")).toBe(false);
    const { POST } = await import("@/app/api/jellyfin/playback/stop/route");
    const res = await POST(req({ itemId, playSessionId: "p3", mediaSourceId: "ms", positionTicks: 10 }));
    expect(res.status).toBe(200);
    expect(activeTranscodes("jf-1")).toBe(4);
    expect(admitTranscode("jf-1", "p5")).toBe(true);
  });
});
