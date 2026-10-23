import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Le passage d'adresse devant le proxy (DECISIONS.md §119) : exactement deux adresses s'ouvrent sans
 * session — la page d'arrivée et son entrée —, l'entrée reste une écriture de même origine, et la
 * demande est ouverte au foyer, fermée aux liens de partage.
 */

const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn(), delete: vi.fn() } }));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
vi.mock("@/lib/share/store", () => ({ sharesDb: { get: () => null }, shareIsActive: () => true }));

function req(method: string, pathname: string, headers: Record<string, string> = {}, cookie = true): NextRequest {
  const url = new URL(`https://app.example.org${pathname}`);
  const h = new Headers({ host: "app.example.org", ...headers });
  return { nextUrl: url, url: url.toString(), method, headers: h, cookies: { get: () => (cookie ? { value: "t" } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue(null);
});

describe("les chemins publics", () => {
  it("la page d'arrivée et l'entrée, et rien d'autre du passage", async () => {
    const { PUBLIC_PATHS, isPublicPath } = await import("@/lib/publicPaths");
    expect(PUBLIC_PATHS.filter((p) => p.includes("passage"))).toEqual(["/passage", "/api/passage/redeem"]);
    expect(isPublicPath("/passage")).toBe(true);
    expect(isPublicPath("/api/passage/redeem")).toBe(true);
    expect(isPublicPath("/api/passage")).toBe(false);
    expect(isPublicPath("/api/passage/arrival")).toBe(false);
    expect(isPublicPath("/passages")).toBe(false);
  });

  it("le proxy les laisse passer sans session, et répond 401 au reste du passage", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/passage", {}, false))).status).toBe(200);
    expect((await proxy(req("POST", "/api/passage/redeem", { "sec-fetch-site": "same-origin" }, false))).status).toBe(200);
    const create = await proxy(req("POST", "/api/passage", { "sec-fetch-site": "same-origin" }, false));
    expect(create.status).toBe(401);
    expect(create.headers.get("x-session-expired")).toBe("1");
    expect((await proxy(req("GET", "/api/passage/arrival", {}, false))).status).toBe(401);
  });

  it("l'entrée, publique, reste une écriture de même origine", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("POST", "/api/passage/redeem", { "sec-fetch-site": "cross-site" }, false))).status).toBe(403);
    expect((await proxy(req("POST", "/api/passage/redeem", { "sec-fetch-site": "same-site", origin: "https://cine.example.org" }, false))).status).toBe(403);
  });
});

describe("la demande", () => {
  it("un compte ordinaire peut demander et accuser ses réglages", async () => {
    mockVerify.mockResolvedValue({ u: "mathis", role: "user", jti: "j" });
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("POST", "/api/passage", { "sec-fetch-site": "same-origin" }))).status).toBe(200);
    expect((await proxy(req("POST", "/api/passage/arrival", { "sec-fetch-site": "same-origin" }))).status).toBe(200);
  });

  it("un lien de partage ne passe pas la porte des liens", async () => {
    mockVerify.mockResolvedValue({ u: "partage-1", role: "share", sh: "0123456789abcdef", jti: "j", exp: Date.now() + 1000 });
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("POST", "/api/passage", { "sec-fetch-site": "same-origin" }));
    expect(res.status).not.toBe(200);
  });
});
