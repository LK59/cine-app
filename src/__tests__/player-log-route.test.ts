import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/playerLog", () => ({
  logPlaybackEvent: (...a: unknown[]) => mockLog(...a),
  isPlayerEventKind: (v: unknown) => ["start", "fallback", "network", "rebuild", "error", "stop", "audio"].includes(v as string),
}));
const jf = {
  userData: { PlaybackPositionTicks: 2421 * 10_000_000, LastPlayedDate: "" } as Record<string, unknown>,
  runtime: 3436 * 10_000_000,
  saved: [] as [string, string, number][],
  sessions: [] as { UserId: string; NowPlayingItem?: { Id: string }; LastPlaybackCheckIn?: string }[],
};
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemUserData: async () => ({ UserData: jf.userData, RunTimeTicks: jf.runtime }),
    getSessions: async () => jf.sessions,
    savePositionAsAdmin: async (userId: string, itemId: string, ticks: number) => {
      jf.saved.push([userId, itemId, ticks]);
    },
  },
}));
let playerEnabled = true;
vi.mock("@/lib/config", () => ({ config: { get player() { return { enabled: playerEnabled }; } } }));

function fakeReq(body: unknown, cookie = "t"): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" && cookie ? { value: cookie } : undefined) },
    json: async () => body,
  } as unknown as NextRequest;
}

const post = async (body: unknown, cookie?: string) => {
  const { POST } = await import("@/app/api/player/log/route");
  return POST(fakeReq(body, cookie));
};

beforeEach(() => {
  vi.clearAllMocks();
  playerEnabled = true;
  mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1" });
});

describe("POST /api/player/log", () => {
  it("écrit l'événement au nom du compte de la session", async () => {
    // Never the account named in the body: the one field that says who this was about must not
    // be the one field anybody can forge.
    const res = await post({ kind: "fallback", fields: { reason: "tampon", user: "quelqu-un-dautre" } });
    expect(res.status).toBe(200);
    expect(mockLog).toHaveBeenCalledWith("louis", "fallback", expect.objectContaining({ reason: "tampon" }));
  });

  it("refuse un type d'événement inventé", async () => {
    expect((await post({ kind: "tout-le-disque", fields: {} })).status).toBe(400);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("accepte un événement sans détails", async () => {
    expect((await post({ kind: "start" })).status).toBe(200);
    expect(mockLog).toHaveBeenCalledWith("louis", "start", {});
  });

  it("n'écoute ni un visiteur sans session ni un lecteur désactivé", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    expect((await post({ kind: "start" }, "")).status).toBe(403);

    playerEnabled = false;
    expect((await post({ kind: "start" })).status).toBe(404);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("ne laisse que l'administrateur marquer une ligne comme venant du banc", async () => {
    // Une ligne `bench` part dans bench-player.log : ouvert à tous, n'importe quel compte pouvait
    // sortir ses propres lignes du journal des spectateurs.
    mockVerifySessionFull.mockResolvedValue({ u: "mathis", role: "user", jfId: "jf-2" });
    await post({ kind: "stop", fields: { bench: "banc-x", at: 12 } });
    expect(mockLog.mock.calls[0][2]).not.toHaveProperty("bench");

    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin", jfId: "jf-1" });
    await post({ kind: "stop", fields: { bench: "banc-x", at: 12 } });
    expect(mockLog.mock.calls[1][2]).toMatchObject({ bench: "banc-x" });
  });
});

// Love Story, 24/09/2026 : le réseau perdu 25 s avant qu'iOS ferme la page — Jellyfin avait 40:21,
// le téléphone 40:48, et l'épisode a repris à 40:16. Le bilan perdu rend la position à Jellyfin.
describe("un bilan perdu rend sa position à Jellyfin", () => {
  const NOW = Date.parse("2026-09-24T15:32:39Z");
  const lost = (extra: Record<string, unknown> = {}) => ({
    kind: "stop",
    fields: { why: "lost", itemId: "love", at: 2448, lateByMs: 47 * 60_000, ...extra },
  });
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    jf.saved = [];
    jf.sessions = [];
    // Ce que Jellyfin avait réellement : la position du dernier battement, datée de l'arrêt qu'il a
    // prononcé seul cinq minutes après le silence — pas une lecture plus récente.
    jf.userData = { PlaybackPositionTicks: 2421 * 10_000_000, LastPlayedDate: new Date(NOW - 47 * 60_000 + 5 * 60_000).toISOString() };
  });
  afterEach(() => vi.useRealTimers());

  it("avance la position, et le dit dans la ligne", async () => {
    await post(lost());
    expect(jf.saved).toEqual([["jf-1", "love", 2448 * 10_000_000]]);
    expect(mockLog).toHaveBeenCalledWith("louis", "stop", expect.objectContaining({ resumeFix: "avancée de 27 s" }));
  });

  it("ne touche à rien si le titre a été lu depuis, s'il est en cours, ou si Jellyfin est déjà plus loin", async () => {
    jf.userData = { PlaybackPositionTicks: 100 * 10_000_000, LastPlayedDate: new Date(NOW - 60_000).toISOString() };
    await post(lost());
    jf.userData = { PlaybackPositionTicks: 2421 * 10_000_000, LastPlayedDate: new Date(NOW - 50 * 60_000).toISOString() };
    jf.sessions = [{ UserId: "jf-1", NowPlayingItem: { Id: "love" }, LastPlaybackCheckIn: new Date(NOW - 5_000).toISOString() }];
    await post(lost());
    jf.sessions = [];
    jf.userData = { PlaybackPositionTicks: 2500 * 10_000_000, LastPlayedDate: new Date(NOW - 50 * 60_000).toISOString() };
    await post(lost());
    expect(jf.saved).toEqual([]);
    expect(mockLog.mock.calls.map((c) => (c[2] as { resumeFix?: string }).resumeFix)).toEqual(["lu depuis", "en cours de lecture", "déjà à jour"]);
  });

  // La session de la séance perdue elle-même, encore listée par Jellyfin mais muette depuis la
  // mort de la page : elle ne doit pas passer pour une lecture en cours.
  it("ne prend pas la session morte de la séance perdue pour une lecture en cours", async () => {
    jf.sessions = [{ UserId: "jf-1", NowPlayingItem: { Id: "love" }, LastPlaybackCheckIn: new Date(NOW - 3 * 60_000).toISOString() }];
    await post(lost());
    expect(jf.saved).toEqual([["jf-1", "love", 2448 * 10_000_000]]);
  });

  it("ni un arrêt ordinaire, ni une fin de film, ni une position au-delà des seuils", async () => {
    await post({ kind: "stop", fields: { why: "close", itemId: "love", at: 2448 } });
    await post(lost({ ended: true }));
    await post(lost({ at: 3300 }));
    expect(jf.saved).toEqual([]);
  });
});

