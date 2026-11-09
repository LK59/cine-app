import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Le déclencheur des acteurs à l'écran (DECISIONS.md §138) : la ligne `start` du journal du lecteur —
 * la seule que les lecteurs natif, serveur et Chromecast écrivent tous, avec l'élément et la position.
 * Ni un banc, ni le lecteur hors ligne, ni une option coupée ; et la ligne s'écrit quoi qu'il arrive.
 */

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/playerLog", () => ({
  logPlaybackEvent: (...a: unknown[]) => mockLog(...a),
  isPlayerEventKind: (v: unknown) => ["start", "stop", "stall"].includes(v as string),
}));
vi.mock("@/lib/config", () => ({ config: { player: { enabled: true } } }));
const xr = vi.hoisted(() => ({ configured: true }));
vi.mock("@/lib/clients/xray", () => ({ xrayConfigured: () => xr.configured }));
const mockNote = vi.fn();
vi.mock("@/lib/xray/orders", () => ({ noteSessionStart: (...a: unknown[]) => mockNote(...a) }));
vi.mock("@/lib/share/guard", () => ({
  shareRefusal: async (session: { role?: string }, itemId: unknown) => (session.role === "share" && itemId !== "a".repeat(32) ? new Response(null, { status: 403 }) : null),
}));

const ITEM = "a".repeat(32);

async function post(kind: string, fields: Record<string, unknown>) {
  const { POST } = await import("@/app/api/player/log/route");
  return POST({ cookies: { get: () => ({ value: "t" }) }, json: async () => ({ kind, fields }) } as unknown as NextRequest);
}

beforeEach(() => {
  vi.clearAllMocks();
  xr.configured = true;
  mockVerify.mockResolvedValue({ u: "louis", jfId: "f".repeat(32), role: "user" });
});

describe("POST /api/player/log → acteurs à l'écran", () => {
  it("une ligne `start` commande l'analyse de l'élément, à sa position, au nom du compte", async () => {
    expect((await post("start", { itemId: ITEM, at: 812.4, path: "remux" })).status).toBe(200);
    expect(mockNote).toHaveBeenCalledWith(ITEM, 812.4, "louis");
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it("le lecteur du serveur aussi (sa ligne porte `at` = la reprise)", async () => {
    await post("start", { itemId: ITEM, at: 0, path: "serveur", why: "open" });
    expect(mockNote).toHaveBeenCalledWith(ITEM, 0, "louis");
  });

  it("ni les autres lignes, ni un banc, ni le lecteur hors ligne, ni l'option coupée", async () => {
    await post("stall", { itemId: ITEM, at: 10 });
    // Le champ `bench` n'est gardé que pour l'administrateur, qui seul lance un banc.
    mockVerify.mockResolvedValueOnce({ u: "admin", jfId: "f".repeat(32), role: "admin" });
    await post("start", { itemId: ITEM, at: 10, bench: "b1" });
    await post("start", { itemId: ITEM, at: 10, player: "hors-ligne" });
    xr.configured = false;
    await post("start", { itemId: ITEM, at: 10 });
    expect(mockNote).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledTimes(4);
  });

  it("un lien de partage : seulement son titre", async () => {
    mockVerify.mockResolvedValue({ u: "partage", jfId: "f".repeat(32), role: "share", sh: "x" });
    await post("start", { itemId: "b".repeat(32), at: 1 });
    expect(mockNote).not.toHaveBeenCalled();
    await post("start", { itemId: ITEM, at: 1 });
    expect(mockNote).toHaveBeenCalledTimes(1);
  });
});
