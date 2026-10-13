import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * La page Santé et la page d'état, alignées sur la vue d'ensemble (13/10/2026) : un service non
 * configuré n'est pas une panne. Une installation sans Bazarr ni Jackett lisait « en panne » en
 * tête des deux pages, des cartes rouges « Hors ligne », et une disponibilité de 0 % sur chaque
 * fonction qui les attend — pour une clé que personne n'avait posée.
 */
const mockConfig = vi.hoisted(() => ({
  jellyfin: { url: "http://jf.local", apiKey: "k" },
  jellyseerr: { url: "http://js.local", apiKey: "k" },
  radarr: { url: "http://radarr.local", apiKey: "k" },
  sonarr: { url: "http://sonarr.local", apiKey: "k" },
  bazarr: { url: "http://bazarr.local", apiKey: "" },
  jackett: { url: "http://jackett.local", apiKey: "" },
  qbittorrent: { url: "", password: "" },
  tmdb: { apiKey: "k" },
  mdblist: { apiKey: "" },
}));
vi.mock("@/lib/config", () => ({ config: mockConfig }));
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getSystemInfo: vi.fn(async () => ({ Version: "1" })) } }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/media-paths", () => ({
  MEDIA_ROOT: "/tmp", MOVIES_PATH: "/tmp", TV_PATH: "/tmp", SEEDS_PATH: "/tmp",
  SEED_MOVIES_PATH: "/tmp", SEED_TV_PATH: "/tmp", CROSS_SEED_PATH: "/tmp",
}));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const recordServiceChecks = vi.fn();
const recordCapabilityChecks = vi.fn();
vi.mock("@/lib/db", () => ({
  getDb: () => ({ prepare: () => ({ get: () => 1 }) }),
  statusHistoryDb: {
    recordServiceChecks: (...a: unknown[]) => recordServiceChecks(...a),
    recordCapabilityChecks: (...a: unknown[]) => recordCapabilityChecks(...a),
    getCapabilityHistory: () => [],
    getServiceLatencyStats: () => [
      { service: "radarr", samples: 10, avgMs: 20, maxMs: 40, failures: 0 },
      { service: "bazarr", samples: 10, avgMs: null, maxMs: null, failures: 10 },
    ],
  },
}));
vi.mock("@/lib/rateLimiter", () => ({ createRateLimiter: () => () => true }));
vi.mock("@/lib/api-helpers", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

const fetchSpy = vi.fn(async (_url?: unknown) => new Response(JSON.stringify({ Version: "1", version: "1" }), { status: 200 }));
const req = (path = "/api/health") =>
  ({ nextUrl: new URL(`http://x${path}`), cookies: { get: () => ({ value: "t" }) } }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchSpy);
  mockVerifySessionFull.mockResolvedValue({ role: "admin" });
  process.env.VAPID_PUBLIC_KEY = "pub";
  process.env.VAPID_PRIVATE_KEY = "priv";
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/health — page Santé", () => {
  it("marque les services non configurés, ne les interroge pas, et ne les compte pas dans l'état", async () => {
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET(req())).json();
    expect(body.overall).toBe("ok");
    const byName = Object.fromEntries(body.services.map((s: { name: string }) => [s.name, s]));
    expect(byName.Bazarr).toMatchObject({ configured: false });
    expect(byName.Jackett).toMatchObject({ configured: false });
    expect(byName.qBittorrent).toMatchObject({ configured: false });
    expect(byName.Radarr.configured).toBeUndefined();
    const called = fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(called.some((u) => u.includes("bazarr") || u.includes("jackett"))).toBe(false);
    // Les vieux échecs d'un service débranché ne restent pas dans l'historique affiché.
    expect(body.latencyHistory.map((s: { service: string }) => s.service)).toEqual(["radarr"]);
  });

  it("une vraie panne d'un service configuré reste une panne", async () => {
    fetchSpy.mockImplementation(async (url: unknown) => {
      if (String(url).includes("radarr")) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ Version: "1", version: "1" }), { status: 200 });
    });
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET(req())).json();
    expect(body.overall).toBe("down");
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ Version: "1", version: "1" }), { status: 200 }));
  });

  it("un compte non admin voit « non configuré » sans le message (variables d'environnement)", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "user" });
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET(req())).json();
    const bazarr = body.services.find((s: { name: string }) => s.name === "Bazarr");
    expect(bazarr).toMatchObject({ configured: false, error: null, url: "" });
  });
});

describe("capacités — page d'état", () => {
  it("une fonction dont un service requis n'est pas configuré est « non configurée », sans note", async () => {
    const { runAllServiceChecks, computeCapabilities, overallStatus } = await import("@/lib/healthChecks");
    const caps = computeCapabilities(await runAllServiceChecks());
    const by = Object.fromEntries(caps.map((c) => [c.id, c]));
    expect(by.searchEngine.configured).toBe(false);
    expect(by.subtitles.configured).toBe(false);
    expect(by.multiSourceRatings.configured).toBe(false);
    // addMovies attend Jackett (requis) : non configurée, pas « dégradée faute de qBittorrent ».
    expect(by.addMovies).toMatchObject({ configured: false, note: null });
    expect(by.movieLibrary.configured).toBeUndefined();
    expect(by.movieLibrary.status).toBe("ok");
    expect(overallStatus(caps)).toBe("ok");
  });

  it("une dépendance souple non configurée ne dégrade rien", async () => {
    mockConfig.jackett.apiKey = "k";
    try {
      const { runAllServiceChecks, computeCapabilities } = await import("@/lib/healthChecks");
      const caps = computeCapabilities(await runAllServiceChecks());
      const addMovies = caps.find((c) => c.id === "addMovies")!;
      expect(addMovies).toMatchObject({ status: "ok", note: null });
      expect(addMovies.configured).toBeUndefined();
      expect(caps.find((c) => c.id === "download")!.configured).toBe(false);
    } finally {
      mockConfig.jackett.apiKey = "";
    }
  });

  it("GET /api/status/public : état « ok », fonctions non configurées marquées, avec ou sans session", async () => {
    const { GET } = await import("@/app/api/status/public/route");
    const body = await (await GET(req("/api/status/public?refresh=1"))).json();
    expect(body.overall).toBe("ok");
    expect(body.capabilities.find((c: { id: string }) => c.id === "searchEngine")).toMatchObject({ configured: false });

    mockVerifySessionFull.mockResolvedValue(null);
    mockConfig.jellyfin.apiKey = "";
    try {
      const anon = await (await GET(req("/api/status/public"))).json();
      expect(anon.overall).toBe("ok");
      expect(anon.capabilities.every((c: { configured?: boolean }) => c.configured === false)).toBe(true);
    } finally {
      mockConfig.jellyfin.apiKey = "k";
    }
  });

  it("le relevé du cron n'écrit rien pour ce qui n'est pas configuré", async () => {
    const { runStatusPoll } = await import("@/lib/statusCron");
    await runStatusPoll();
    const services = Object.keys(recordServiceChecks.mock.calls[0][0] as object);
    expect(services).toContain("radarr");
    expect(services).not.toContain("bazarr");
    expect(services).not.toContain("qbittorrent");
    expect(services).not.toContain("mdblist");
    const caps = (recordCapabilityChecks.mock.calls[0][0] as { id: string }[]).map((c) => c.id);
    expect(caps).toContain("movieLibrary");
    expect(caps).not.toContain("searchEngine");
  });
});
