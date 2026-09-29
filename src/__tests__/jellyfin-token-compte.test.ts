import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/http";

/**
 * La session ne relisait jamais le compte Jellyfin (A9+B1) : le rôle lu à la connexion était
 * recopié par chaque prolongation glissante, et seul un 401 sur `/Users/Me` fermait la session.
 * Un administrateur rétrogradé restait administrateur à vie, et un compte désactivé (403, ou
 * `Policy.IsDisabled`) gardait l'accès. Le geste même qu'on fait pour retirer un accès ne
 * retirait rien.
 */

const mockJellyfin = { checkUserToken: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
}));
const mockSessionDb = { touch: vi.fn(), delete: vi.fn() };
vi.mock("@/lib/db", () => ({ sessionDb: mockSessionDb }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

const ADMIN = { u: "a", jfUser: "a", role: "admin" as const, jti: "s-a", jfId: "jf-a", jfToken: "t", exp: 0 };
const USER = { u: "b", jfUser: "b", role: "user" as const, jti: "s-b", jfId: "jf-b", jfToken: "t", exp: 0 };
const me = (policy: Record<string, unknown>) => ({ Id: "jf", Policy: { IsAdministrator: false, IsDisabled: false, ...policy } });

function req(pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method: "GET", cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  (await import("@/lib/jellyfinToken")).__testing.reset();
});

describe("jellyfinTokenAlive relit le compte", () => {
  it("ferme sur un 403 (compte désactivé)", async () => {
    mockJellyfin.checkUserToken.mockRejectedValue(new HttpError("403 Forbidden", 403));
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(USER)).toBe(false);
  });

  it("ferme sur un 401, comme avant", async () => {
    mockJellyfin.checkUserToken.mockRejectedValue(new HttpError("401", 401));
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(USER)).toBe(false);
  });

  it("ferme quand Policy.IsDisabled est vrai", async () => {
    mockJellyfin.checkUserToken.mockResolvedValue(me({ IsDisabled: true }));
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(USER)).toBe(false);
  });

  it("ferme la session d'un administrateur rétrogradé", async () => {
    mockJellyfin.checkUserToken.mockResolvedValue(me({ IsAdministrator: false }));
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(ADMIN)).toBe(false);
  });

  it("ferme la session d'un compte promu administrateur (le rôle ne se relit qu'à la connexion)", async () => {
    mockJellyfin.checkUserToken.mockResolvedValue(me({ IsAdministrator: true }));
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(USER)).toBe(false);
  });

  it("garde une session dont le compte n'a pas changé", async () => {
    mockJellyfin.checkUserToken.mockResolvedValue(me({ IsAdministrator: true }));
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(ADMIN)).toBe(true);
    mockJellyfin.checkUserToken.mockResolvedValue(me({}));
    expect(await jellyfinTokenAlive(USER)).toBe(true);
  });

  it("ne conclut rien d'une réponse sans Policy, ni d'une panne", async () => {
    mockJellyfin.checkUserToken.mockResolvedValue({ Id: "jf" });
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(ADMIN)).toBe(true);
    mockJellyfin.checkUserToken.mockRejectedValue(new HttpError("502", 502));
    expect(await jellyfinTokenAlive(USER)).toBe(true);
  });

  it("ne touche pas au compte admin local, qui n'a pas de jeton Jellyfin", async () => {
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive({ u: "admin", role: "admin", jti: "s-l", exp: 0 })).toBe(true);
    expect(mockJellyfin.checkUserToken).not.toHaveBeenCalled();
  });
});

describe("proxy — un compte changé ferme la session par le même chemin qu'un jeton refusé", () => {
  it("renvoie à la connexion un administrateur rétrogradé", async () => {
    mockVerify.mockResolvedValue(ADMIN);
    mockJellyfin.checkUserToken.mockResolvedValue(me({ IsAdministrator: false }));
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/gestion"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(mockSessionDb.delete).toHaveBeenCalledWith("s-a");
  });
});
