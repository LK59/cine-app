import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const mockJellyfin = { deleteDevice: vi.fn(async () => {}), logoutToken: vi.fn(async () => {}) };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
const mockLog = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLog(...a) }));

beforeEach(() => vi.clearAllMocks());

describe("revokeJellyfinDevices", () => {
  it("ne supprime que les appareils que l'application a inscrits", async () => {
    const { revokeJellyfinDevices } = await import("@/lib/jellyfinRevoke");
    await revokeJellyfinDevices(["cine-app-abc", "TW96aWxsYS", null, "Qk9UX3NlZXJy"], "essai");
    expect(mockJellyfin.deleteDevice).toHaveBeenCalledTimes(1);
    expect(mockJellyfin.deleteDevice).toHaveBeenCalledWith("cine-app-abc");
  });

  it("ne lève jamais : un Jellyfin absent n'empêche pas de se déconnecter", async () => {
    mockJellyfin.deleteDevice.mockRejectedValueOnce(new Error("fetch failed"));
    const { revokeJellyfinDevices } = await import("@/lib/jellyfinRevoke");
    await expect(revokeJellyfinDevices(["cine-app-abc"], "essai")).resolves.toBeUndefined();
    expect(mockLog).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/auth/sessions — « déconnecter tous les autres »", () => {
  it("ne ferme que les sessions de l'application, sans rien révoquer chez Jellyfin", async () => {
    vi.doMock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
    vi.doMock("@/lib/session", () => ({ verifySessionFull: async () => ({ u: "louis", jfId: "jf", jti: "moi" }) }));
    const deleteOthers = vi.fn(() => 2);
    vi.doMock("@/lib/db", () => ({ sessionDb: { deleteOthers } }));
    const { DELETE } = await import("@/app/api/auth/sessions/route");
    const res = await DELETE({ cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(deleteOthers).toHaveBeenCalledWith("jf", "moi");
    expect(mockJellyfin.deleteDevice).not.toHaveBeenCalled();
    expect(mockJellyfin.logoutToken).not.toHaveBeenCalled();
  });
});
