import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Même harnais que proxy-guest-mutations : aucune session n'a assez vieilli pour être prolongée.
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

function req(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ u: "compte", role: "user" });
});

// `/api/activity` était réservée à l'administrateur, mais la même donnée — l'historique de Radarr
// et Sonarr, indexeur compris — sortait par `/api/dashboard` (champ `activity`) et
// `/api/timeline/imports` ; et `/api/stats/storage?refresh=1` laissait tout compte relancer en
// boucle le parcours complet des disques. La règle écrite ne protégeait rien.
describe("proxy — management reads", () => {
  const ROUTES = ["/api/dashboard", "/api/timeline/imports", "/api/stats/storage", "/api/stats/storage?refresh=1"];

  it("refuses them to a plain user", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of ROUTES) {
      expect((await proxy(req("GET", path))).status, path).toBe(403);
    }
  });

  it("lets an administrator read them", async () => {
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    const { proxy } = await import("@/proxy");
    for (const path of ROUTES) {
      expect((await proxy(req("GET", path))).status, path).toBe(200);
    }
  });

  // Motifs exacts : les voisins ne sont pas attrapés au passage.
  it("does not catch neighbouring routes", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of ["/api/stats/storage-forecast", "/api/stats/library", "/api/stats"]) {
      expect((await proxy(req("GET", path))).status, path).toBe(200);
    }
  });
});
