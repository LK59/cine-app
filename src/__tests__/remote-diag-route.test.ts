import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/eventLogs", () => ({ logRemoteDiag: (...a: unknown[]) => mockLog(...a) }));
vi.mock("@/lib/writeLimits", () => ({ remoteDiagAllowed: () => true }));

/**
 * Le relevé de télécommande d'une Fire TV (12/10/2026) : un par mode de Silk, avec le focus avant /
 * après chaque touche et les focus déplacés sans touche. Tout reste borné, au nom du compte de la
 * session et de lui seul.
 */
const SILK = "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0.7977.140 Safari/537.36";
function fakeReq(body: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) },
    headers: new Headers({ "user-agent": SILK }),
    json: async () => body,
  } as unknown as NextRequest;
}
const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/remote-diag/route");
  return POST(fakeReq(body));
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionFull.mockResolvedValue({ u: "timothe", jfUser: "Timothe", role: "user" });
});

describe("POST /api/remote-diag", () => {
  it("garde le mode, les touches avec leur focus avant / après, et les focus déplacés sans touche", async () => {
    const res = await post({
      user: "quelqu'un d'autre",
      mode: "spatial",
      report: 2,
      keys: [{ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, target: "button[carte r#3]", prevented: true, t: 10, before: "button[carte r#3]", after: "button[carte r#2]", gridMoved: true }],
      focusMoves: [{ t: 40, from: "button[carte r#2]", to: "button[carte r#1]" }],
      pointerMoves: 3,
      pointerAtFocus: 2,
      wheels: 0,
      edgeScrolls: 1,
      spentMs: 5000,
      viewport: "960x540",
    });
    expect(res.status).toBe(204);
    const line = mockLog.mock.calls[0][0];
    expect(line).toMatchObject({
      user: "Timothe",
      mode: "spatial",
      report: 2,
      keys: [expect.objectContaining({ before: "button[carte r#3]", after: "button[carte r#2]", gridMoved: true })],
      focusMoves: [{ t: 40, from: "button[carte r#2]", to: "button[carte r#1]" }],
      pointerAtFocus: 2,
      edgeScrolls: 1,
      viewport: "960x540",
    });
    expect(line.device).toContain("Fire TV");
  });

  it("borne tout : vingt focus déplacés, des chaînes courtes, un mode connu ou rien", async () => {
    await post({
      mode: "autre",
      keys: [{ key: "x".repeat(100), before: "y".repeat(200), gridMoved: "oui" }],
      focusMoves: Array.from({ length: 50 }, () => ({ t: -5, from: "z".repeat(200), to: 3 })),
      pointerAtFocus: Number.NaN,
    });
    const line = mockLog.mock.calls[0][0];
    expect(line).not.toHaveProperty("mode");
    expect(line.keys[0].key).toHaveLength(24);
    expect(line.keys[0].before).toHaveLength(60);
    expect(line.keys[0].gridMoved).toBe(false);
    expect(line.focusMoves).toHaveLength(20);
    expect(line.focusMoves[0]).toEqual({ t: 0, from: "z".repeat(60), to: "" });
    expect(line.pointerAtFocus).toBe(0);
  });

  it("l'ancien format (sans mode) passe toujours", async () => {
    const res = await post({ keys: [], pointerMoves: 258, wheels: 0, spentMs: 49568, viewport: "960x540" });
    expect(res.status).toBe(204);
    expect(mockLog.mock.calls[0][0]).toMatchObject({ keys: [], focusMoves: [], pointerMoves: 258 });
  });
});
