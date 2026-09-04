import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/playerLog", () => ({
  logPlaybackEvent: (...a: unknown[]) => mockLog(...a),
  isPlayerEventKind: (v: unknown) => ["start", "fallback", "network", "rebuild", "error", "stop"].includes(v as string),
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
});
