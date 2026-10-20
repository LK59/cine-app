import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Les corrections de la revue de sécurité du 20/10/2026 que porte la porte elle-même : l'adresse
 * décodée avant toute règle, trois lectures rendues à la gestion, un jeton Jellyfin mort qui ne
 * prolonge plus une session d'API ni ne laisse ses droits à un administrateur, et le freinage des
 * connexions par préfixe IPv6 et par compte.
 */

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => true,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn(), delete: vi.fn(() => null) } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const token = vi.hoisted(() => ({ dead: false, checks: 0 }));
vi.mock("@/lib/jellyfinToken", () => ({
  jellyfinTokenAlive: async () => {
    token.checks += 1;
    return !token.dead;
  },
  jellyfinTokenKnownDead: () => token.dead,
  forgetJellyfinToken: vi.fn(),
}));
vi.mock("@/lib/jellyfinRevoke", () => ({ revokeJellyfinDevices: vi.fn(async () => undefined) }));

function req(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  token.dead = false;
  token.checks = 0;
  mockVerify.mockResolvedValue({ u: "mathis", role: "user", jti: "j", jfToken: "jt", exp: Date.now() + 1e9 });
});

describe("l'adresse décodée", () => {
  it("un chemin encodé ne contourne plus les règles des rôles", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("PUT", "/%61pi/settings"))).status).toBe(403);
    expect((await proxy(req("GET", "/%61pi/dashboard"))).status).toBe(403);
    expect((await proxy(req("GET", "/api/st%61ts/storage"))).status).toBe(403);
    expect((await proxy(req("GET", "/%67estion"))).headers.get("location")).toBe("https://cine.example/");
  });

  it("un encodage illisible est refusé", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/%E0%A4%A"))).status).toBe(400);
  });

  it("l'écriture venue d'une autre page se voit aussi sous un chemin encodé", async () => {
    const { crossSiteWrite } = await import("@/lib/crossSite");
    const r = { ...req("POST", "/%61pi/watchlist"), headers: new Headers({ "sec-fetch-site": "cross-site" }) } as unknown as NextRequest;
    expect(crossSiteWrite(r)).toBe(true);
  });
});

describe("les lectures de la gestion", () => {
  it("recherches Radarr/Sonarr et bibliothèque Jellyfin : administrateur seul", async () => {
    const { proxy } = await import("@/proxy");
    for (const p of ["/api/radarr/movies/lookup", "/api/sonarr/series/lookup", "/api/jellyfin/library"]) {
      expect((await proxy(req("GET", p))).status, p).toBe(403);
    }
    expect((await proxy(req("GET", "/api/jellyfin/library/refresh"))).status).toBe(200);
  });
});

describe("un jeton Jellyfin mort, sur l'API", () => {
  it("la question part en arrière-plan sans être attendue, et la session se prolonge", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("GET", "/api/cinema/movies"));
    expect(res.status).toBe(200);
    expect(token.checks).toBe(1);
    expect(res.cookies.get("cine_session")?.value).toBe("renouvelé");
  });

  it("un compte ordinaire garde sa requête, mais sa session ne se prolonge plus", async () => {
    token.dead = true;
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("GET", "/api/jellyfin/stream/" + "a".repeat(32) + "/stream.mkv"));
    expect(res.status).toBe(200);
    expect(res.cookies.get("cine_session")).toBeUndefined();
  });

  it("un administrateur perd ses droits aussitôt", async () => {
    token.dead = true;
    mockVerify.mockResolvedValue({ u: "louis", role: "admin", jti: "k", jfToken: "jt", exp: Date.now() + 1e9 });
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("DELETE", "/api/radarr/movies/12"));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-session-expired")).toBe("1");
  });
});

describe("le freinage des connexions", () => {
  it("une IPv6 compte par son /64 ; une IPv4, telle quelle", async () => {
    const { rateKey } = await import("@/lib/rateLimiter");
    expect(rateKey("2001:db8:1:2:aaaa::1")).toBe(rateKey("2001:0db8:0001:0002:ffff:eeee:dddd:cccc"));
    expect(rateKey("2001:db8:1:2::1")).not.toBe(rateKey("2001:db8:1:3::1"));
    expect(rateKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(rateKey("192.0.2.7")).toBe("192.0.2.7");
  });

  it("des adresses tournantes dans un même /64 partagent leurs dix essais", async () => {
    const { checkRateLimit } = await import("@/lib/rateLimiter");
    let allowed = 0;
    for (let i = 0; i < 30; i++) if (checkRateLimit(`2001:db8:9:9::${i.toString(16)}`)) allowed++;
    expect(allowed).toBe(10);
  });

  it("vingt échecs par heure pour un même compte, d'où qu'ils viennent ; un succès rend sa place", async () => {
    const { checkAccountRateLimit, refundAccountRateLimit } = await import("@/lib/rateLimiter");
    const now = Date.now();
    for (let i = 0; i < 20; i++) expect(checkAccountRateLimit("Augustine", now)).toBe(true);
    expect(checkAccountRateLimit("augustine", now)).toBe(false);
    refundAccountRateLimit("AUGUSTINE");
    expect(checkAccountRateLimit("augustine", now)).toBe(true);
    expect(checkAccountRateLimit("augustine", now + 3_600_001)).toBe(true);
  });
});
