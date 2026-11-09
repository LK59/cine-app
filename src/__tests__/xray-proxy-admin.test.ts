import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Les acteurs à l'écran et les portes (DECISIONS.md §138) : la lecture du lecteur ouverte à tout compte
 * et, pour un lien de partage, à son seul titre ; la route du banc à l'administrateur seul, lecture
 * comprise ; et la ligne `start` du journal du lecteur qui commande l'analyse.
 */

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

const MOVIE = "a".repeat(32);
const OTHER = "e".repeat(32);
const EXPIRES = Date.now() + 86_400_000;
vi.mock("@/lib/share/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/share/store")>();
  const share = {
    id: "0123456789abcdef",
    code: "abcdefghjk",
    kind: "movie",
    itemId: "a".repeat(32),
    radarrId: 12,
    sonarrId: null,
    expiresAt: Date.now() + 86_400_000,
    revokedAt: null,
    maxStreams: 3,
    jfUserId: "f".repeat(32),
    jfUserName: "partage-01234567",
    jfDeletedAt: null,
  };
  return { ...real, sharesDb: { get: () => share, jellyfinUserIds: () => new Set<string>() } };
});
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getItemBasic: async () => ({ Type: "Movie" }) } }));

function req(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  (await import("@/lib/share/scope")).__testing.reset();
});

describe("le proxy", () => {
  it("ouvre la lecture du lecteur à un compte ordinaire", async () => {
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", `/api/player/xray/${MOVIE}`))).status).toBe(200);
  });

  it("réserve la route du banc à l'administrateur, lecture comprise", async () => {
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/admin/xray"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/admin/xray"))).status).toBe(403);
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    expect((await proxy(req("GET", "/api/admin/xray"))).status).toBe(200);
    expect((await proxy(req("POST", "/api/admin/xray"))).status).toBe(200);
  });

  it("un lien de partage : les acteurs de son titre, et d'aucun autre", async () => {
    mockVerify.mockResolvedValue({ u: "partage-01234567", jfUser: "partage-01234567", role: "share", sh: "0123456789abcdef", jti: "j", exp: EXPIRES });
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", `/api/player/xray/${MOVIE}`))).status).toBe(200);
    expect((await proxy(req("GET", `/api/player/xray/${OTHER}`))).status).toBe(403);
    expect((await proxy(req("GET", "/api/admin/xray"))).status).toBe(403);
  });
});

describe("la route du banc", () => {
  it("refuse tout compte qui n'est pas administrateur", async () => {
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    const { GET, POST } = await import("@/app/api/admin/xray/route");
    const r = { cookies: { get: () => ({ value: "t" }) }, nextUrl: new URL("https://cine.example/api/admin/xray"), json: async () => ({ itemId: MOVIE }) } as unknown as NextRequest;
    expect((await GET(r)).status).toBe(403);
    expect((await POST(r)).status).toBe(403);
  });
});
