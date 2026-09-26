import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/session", () => ({ verifySessionFull: vi.fn(async () => ({ u: "louis", role: "admin", jti: "j" })) }));

import { crossSiteWrite, proxy } from "@/proxy";

// 26/09/2026 : un POST `text/plain` venu d'un autre sous-domaine du même domaine écrivait dans la
// liste de qui était connecté — `SameSite=Lax` ne sépare pas les sites frères.
function req(method: string, pathname: string, headers: Record<string, string> = {}): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  const h = new Headers({ host: "cine.example", ...headers });
  return { nextUrl: url, url: url.toString(), method, headers: h, cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

describe("crossSiteWrite", () => {
  it("laisse passer nos propres écritures, beacons compris", () => {
    expect(crossSiteWrite(req("POST", "/api/watchlist", { "sec-fetch-site": "same-origin", origin: "https://cine.example" }))).toBe(false);
    expect(crossSiteWrite(req("POST", "/api/player/log", { "sec-fetch-site": "same-origin" }))).toBe(false);
  });

  it("refuse une écriture d'un site frère ou tiers", () => {
    expect(crossSiteWrite(req("POST", "/api/watchlist", { "sec-fetch-site": "same-site", origin: "https://autre.example" }))).toBe(true);
    expect(crossSiteWrite(req("DELETE", "/api/watchlist/1", { "sec-fetch-site": "cross-site" }))).toBe(true);
  });

  it("sans Sec-Fetch-Site, compare l'origine à l'hôte", () => {
    expect(crossSiteWrite(req("POST", "/api/watchlist", { origin: "https://autre.example" }))).toBe(true);
    expect(crossSiteWrite(req("POST", "/api/watchlist", { origin: "https://cine.example" }))).toBe(false);
  });

  it("ne touche ni aux lectures, ni aux pages, ni aux appels sans navigateur", () => {
    expect(crossSiteWrite(req("GET", "/api/watchlist", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(crossSiteWrite(req("POST", "/login", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(crossSiteWrite(req("POST", "/api/watchlist"))).toBe(false);
  });

  it("le proxy répond 403 avant toute autre chose, connexion comprise", async () => {
    const res = await proxy(req("POST", "/api/auth/jellyfin", { "sec-fetch-site": "same-site" }));
    expect(res.status).toBe(403);
  });
});
