import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * La page d'activité nomme ce que chacun a regardé, quand et sur quel appareil. `proxy.ts` ne
 * refuse que les écritures d'un compte ordinaire : une lecture passe. Chaque route doit donc
 * refuser elle-même — c'est ce que ces tests tiennent.
 */
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const listAccounts = vi.fn(async () => []);
vi.mock("@/lib/activity/accounts", () => ({
  listAccounts: () => listAccounts(),
  weekSignals: () => ({}),
  recentSeances: () => [],
  household: () => ({}),
  accountDetail: vi.fn(async () => null),
}));

const req = (url = "https://cine.example/api/admin/activity") =>
  ({ cookies: { get: () => ({ value: "t" }) }, nextUrl: new URL(url), json: async () => ({ action: "closeSessions" }) }) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: "abc" }) };

beforeEach(() => vi.clearAllMocks());

describe("routes d'activité — réservées à l'administrateur", () => {
  for (const role of [null, { u: "lucas", role: "user", jti: "x" }]) {
    const who = role ? "un compte ordinaire" : "sans session";
    it(`refusent la vue d'ensemble ${who}`, async () => {
      mockVerify.mockResolvedValue(role);
      const { GET } = await import("@/app/api/admin/activity/route");
      expect((await GET(req())).status).toBe(403);
      expect(listAccounts).not.toHaveBeenCalled();
    });

    it(`refusent la fiche, ses actions, les journaux et les séances ${who}`, async () => {
      mockVerify.mockResolvedValue(role);
      const account = await import("@/app/api/admin/activity/accounts/[id]/route");
      expect((await account.GET(req(), params)).status).toBe(403);
      expect((await account.POST(req(), params)).status).toBe(403);
      const logs = await import("@/app/api/admin/activity/logs/route");
      expect((await logs.GET(req("https://cine.example/api/admin/activity/logs"))).status).toBe(403);
      const line = await import("@/app/api/admin/activity/logs/line/route");
      expect((await line.GET(req("https://cine.example/api/admin/activity/logs/line?source=player&file=player.log&line=0"))).status).toBe(403);
      const seance = await import("@/app/api/admin/activity/seances/[id]/route");
      expect((await seance.GET(req(), params)).status).toBe(403);
    });
  }

  it("laissent passer l'administrateur", async () => {
    mockVerify.mockResolvedValue({ u: "louis", role: "admin", jti: "a" });
    const { GET } = await import("@/app/api/admin/activity/route");
    expect((await GET(req())).status).toBe(200);
  });
});
