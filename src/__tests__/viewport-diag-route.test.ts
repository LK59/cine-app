import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/eventLogs", () => ({ logViewportDiag: (...a: unknown[]) => mockLog(...a) }));
vi.mock("@/lib/writeLimits", () => ({ viewportDiagAllowed: () => true }));

/**
 * Le relevé de hauteur de l'app installée sur iOS (05/11/2026, `viewportWatch.ts`) : au nom du compte
 * de la session, les champs connus et bornés, rien d'autre.
 */
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
function fakeReq(body: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) },
    headers: new Headers({ "user-agent": IPHONE }),
    json: async () => body,
  } as unknown as NextRequest;
}
const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/viewport-diag/route");
  return POST(fakeReq(body));
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionFull.mockResolvedValue({ u: "louis", jfUser: "louis", role: "admin" });
});

describe("POST /api/viewport-diag", () => {
  it("écrit les hauteurs avant / après au nom de la session, et laisse tomber l'inconnu", async () => {
    const res = await post({
      user: "quelqu'un d'autre",
      trigger: "retour",
      decision: "coincée",
      best: 844,
      before: { inner: 508, vv: 508, client: 508, shell: 508, evil: "x" },
      screen: "390x844",
      build: "abc",
      extra: "rien",
    });
    expect(res.status).toBe(204);
    const line = mockLog.mock.calls[0][0];
    expect(line).toMatchObject({ user: "louis", trigger: "retour", decision: "coincée", best: 844, screen: "390x844" });
    expect(line.before).toEqual({ inner: 508, vv: 508, client: 508, shell: 508 });
    expect(line).not.toHaveProperty("extra");
  });

  it("sans session : 401, rien d'écrit", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    expect((await post({})).status).toBe(401);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("la mesure d'un retour (07/11/2026) : ses champs, bornés, en « retour », et le temps caché en secondes", async () => {
    const res = await post({
      kind: "retour",
      hiddenMs: 3 * 3600_000,
      firstFrameMs: 40,
      frames: 150,
      maxGapMs: 380,
      maxGapAtMs: 520,
      janks: 4,
      longJanks: 1,
      events: ["version:même@180", "listes:9@185", 42, "x".repeat(200)],
      film: false,
      standalone: true,
      cut: "n'importe quoi",
      user: "quelqu'un d'autre",
    });
    expect(res.status).toBe(204);
    const [line, kind] = mockLog.mock.calls[0];
    expect(kind).toBe("retour");
    expect(line).toMatchObject({ user: "louis", hiddenS: 10_800, firstFrameMs: 40, frames: 150, maxGapMs: 380, maxGapAtMs: 520, janks: 4, longJanks: 1, film: false, standalone: true, cut: null });
    expect(line.events).toEqual(["version:même@180", "listes:9@185", "x".repeat(60)]);
  });
});
