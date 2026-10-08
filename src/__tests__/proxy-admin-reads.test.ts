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
    for (const path of ["/api/status/public", "/api/cinema/movies", "/api/cinema/series"]) {
      expect((await proxy(req("GET", path))).status, path).toBe(200);
    }
  });
});

// 08/10/2026 : la bibliothèque telle que la gestion la voit portait en entier un titre que les tags
// bloqués du compte lui cachent (DECISIONS.md §54) — Radarr entier, le calendrier, les torrents…
describe("proxy — la bibliothèque de la gestion", () => {
  const GATED = [
    "/api/radarr/movies",
    "/api/sonarr/series",
    "/api/radarr/movies/12",
    "/api/sonarr/series/7",
    "/api/radarr/movies/lookup",
    "/api/radarr/movies/12/similar",
    "/api/sonarr/series/7/similar",
    "/api/sonarr/series/7/episodes",
    "/api/radarr/queue",
    "/api/sonarr/calendar",
    "/api/radarr/meta",
    "/api/calendar",
    "/api/library/map",
    "/api/stats",
    "/api/stats/library",
    "/api/stats/people",
    "/api/stats/storage-forecast",
    "/api/qbittorrent/torrents",
    "/api/qbittorrent/transfer",
    "/api/jackett/indexers",
    "/api/bazarr/wanted",
    "/api/sse",
    "/api/status",
    "/api/jellyfin/items",
  ];

  it("la refuse à un compte ordinaire", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of GATED) expect((await proxy(req("GET", path))).status, path).toBe(403);
  });

  it("la laisse à l'administrateur", async () => {
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    const { proxy } = await import("@/proxy");
    for (const path of GATED) expect((await proxy(req("GET", path))).status, path).toBe(200);
  });

  // Ce que le cinéma lit, lui, reste ouvert : les descriptions de fiche filtrent elles-mêmes.
  it("laisse au cinéma ce qu'il lit", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of ["/api/radarr/movies/12/info", "/api/sonarr/series/7/info", "/api/cinema/next-up", "/api/jellyfin/resume"]) {
      expect((await proxy(req("GET", path))).status, path).toBe(200);
    }
  });
});

// 08/10/2026 : l'optimiseur d'images était public — n'importe qui remplissait `data/image-cache`.
describe("proxy — l'optimiseur d'images", () => {
  function imageReq(headers: Record<string, string>): NextRequest {
    const url = new URL("https://cine.example/_next/image?url=https%3A%2F%2Fimage.tmdb.org%2Ft%2Fp%2Fw185%2Fx.jpg&w=64&q=75");
    return {
      nextUrl: url,
      url: url.toString(),
      method: "GET",
      headers: new Headers(headers),
      cookies: { get: () => ({ value: "t" }) },
    } as unknown as NextRequest;
  }

  it("le refuse à qui vient de l'extérieur sans session", async () => {
    mockVerify.mockResolvedValue(null);
    const { proxy } = await import("@/proxy");
    expect((await proxy(imageReq({ "x-forwarded-for": "203.0.113.9" }))).status).toBe(401);
  });

  it("le laisse à une session", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(imageReq({ "x-forwarded-for": "203.0.113.9" }))).status).toBe(200);
  });

  it("le laisse au serveur lui-même, qui prépare ses affiches sur la boucle locale", async () => {
    mockVerify.mockResolvedValue(null);
    const { proxy } = await import("@/proxy");
    expect((await proxy(imageReq({}))).status).toBe(200);
  });
});
