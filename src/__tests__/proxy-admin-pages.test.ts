import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { NextRequest } from "next/server";

// Même harnais que proxy-admin-reads : aucune session n'a assez vieilli pour être prolongée.
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

function req(pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method: "GET", cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

/** Chaque page du groupe `(dashboard)`, en adresse (`[id]` remplacé par un identifiant). */
function dashboardPages(): string[] {
  const root = join(process.cwd(), "src", "app", "(dashboard)");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") {
        const rel = relative(root, dir).split(sep).filter(Boolean).map((s) => (s.startsWith("[") ? "42" : s));
        out.push("/" + rel.join("/"));
      }
    }
  };
  walk(root);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ u: "compte", role: "user" });
});

// 15/10/2026 (passe de nuit, BUREAU-14) : `/gestion` se rendait côté serveur pour un compte
// ordinaire, avec dans le HTML ce que `/api/dashboard` lui refuse — versions, compteurs, derniers
// imports par titre. Le proxy est la seule barrière : la page doit y être refusée comme son API.
describe("proxy — les pages de la gestion", () => {
  it("trouve bien les pages du groupe", () => {
    const pages = dashboardPages();
    expect(pages).toContain("/gestion");
    expect(pages).toContain("/radarr/42");
    expect(pages.length).toBeGreaterThan(10);
  });

  it("renvoie un compte ordinaire au cinéma, pour chaque page du groupe", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of dashboardPages()) {
      const res = await proxy(req(path));
      expect([path, res.status]).toEqual([path, 307]);
      expect(res.headers.get("location"), path).toBe("https://cine.example/");
    }
  });

  it("les laisse à l'administrateur", async () => {
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    const { proxy } = await import("@/proxy");
    for (const path of dashboardPages()) {
      const res = await proxy(req(path));
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  // Les voisins ne sont pas attrapés : le cinéma, l'état public des services, les API du cinéma qui
  // partagent un premier segment avec une page (`/api/jellyfin/...` n'est pas `/jellyfin`).
  it("n'attrape ni le cinéma ni les API qui lui servent", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of ["/", "/status", "/api/jellyfin/resume", "/api/radarr/movies/12/info", "/gestionnaire", "/radarrX"]) {
      const res = await proxy(req(path));
      expect([path, res.status]).toEqual([path, 200]);
    }
  });
});
