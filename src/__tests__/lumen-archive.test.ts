import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Lumen serveur archivé (DECISIONS.md §196) : chacune de ses anciennes adresses répond 410 `lumen-archive`, d'une seule
 * route — jamais un 404 par adresse, qu'un onglet périmé ou un téléviseur enchaînerait jusqu'au bannissement par le
 * pare-feu en amont —, et le proxy l'y laisse arriver sans session (un téléviseur n'a pas de cookie).
 */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session", SESSION_MAX_AGE: 604800, shouldRefresh: () => false, refreshSessionToken: async () => "r" }));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));

function proxyReq(method: string, pathname: string, cookie: boolean): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "sec-fetch-site": "same-origin" }),
    cookies: { get: () => (cookie ? { value: "t" } : undefined) },
  } as unknown as NextRequest;
}

const OLD_ADDRESSES = [
  "/api/lumen/film-1/eligibility",
  "/api/lumen/film-1/prepare",
  "/api/lumen/film-1/pistes",
  "/api/lumen/film-1/5-abc/s1/master.m3u8",
  "/api/lumen/film-1/5-abc/s1/v-cra-12.m4s",
  "/api/lumen/film-1/5-abc/s1/tv.jeton/a0-3.m4s",
  "/api/lumen/film-1/5-abc/s1/cc.jeton/master.m3u8",
];

beforeEach(() => {
  verify.mockReset();
});

describe("Lumen serveur archivé — la route unique", () => {
  it("410 `lumen-archive` en GET, POST et OPTIONS ; HEAD sans corps", async () => {
    const route = await import("@/app/api/lumen/[...path]/route");
    for (const answer of [route.GET(), route.POST(), route.OPTIONS()]) {
      expect(answer.status).toBe(410);
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(await answer.json()).toEqual({ error: "lumen-archive" });
    }
    const head = route.HEAD();
    expect(head.status).toBe(410);
    expect(await head.text()).toBe("");
  });
});

describe("Lumen serveur archivé — le proxy", () => {
  it("laisse chaque ancienne adresse jusqu'à la route, sans session comme avec un compte ordinaire", async () => {
    const { proxy } = await import("@/proxy");
    verify.mockResolvedValue(null);
    for (const path of OLD_ADDRESSES) {
      expect((await proxy(proxyReq("GET", path, false))).status, path).toBe(200);
      expect((await proxy(proxyReq("OPTIONS", path, false))).status, path).toBe(200);
    }
    verify.mockResolvedValue({ u: "mathis", role: "user", jti: "j", exp: Date.now() / 1000 + 3600 });
    expect((await proxy(proxyReq("GET", "/api/lumen/film-1/eligibility", true))).status).toBe(200);
    expect((await proxy(proxyReq("POST", "/api/lumen/film-1/prepare", true))).status).toBe(200);
  });
});
