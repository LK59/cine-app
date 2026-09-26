import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/config", () => ({
  config: {
    app: { language: "fr" },
    player: { enabled: true, serverFallback: false },
    gallery: { clara: false },
    // Une installation où seuls Radarr et TMDB sont branchés : de quoi vérifier que la réponse
    // distingue ce qui l'est de ce qui ne l'est pas.
    radarr: { apiKey: "abc" },
    sonarr: { apiKey: "" },
    bazarr: { apiKey: "" },
    jackett: { apiKey: "" },
    jellyfin: { apiKey: "" },
    jellyseerr: { apiKey: "" },
    qbittorrent: { password: "" },
    tmdb: { apiKey: "xyz" },
  },
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
const mockInvalidateLibrary = vi.fn();
vi.mock("@/lib/server-cache", () => ({ invalidateLibrary: () => mockInvalidateLibrary() }));

function fakeReq(cookie = "t"): NextRequest {
  return { cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) } } as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

function configReq(): import("next/server").NextRequest {
  return { cookies: { get: () => ({ value: "t" }) } } as unknown as import("next/server").NextRequest;
}

describe("GET /api/config/public", () => {
  // 26/09/2026 : sans session, la liste de ce qui est branché n'est plus donnée — elle nommait le
  // client BitTorrent et Jackett à n'importe qui.
  it("ne dit pas ce qui est branché à une personne non connectée", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/config/public/route");
    const body = await (await GET(configReq())).json();
    expect(body.configured).toBeUndefined();
    expect(body.defaultLang).toBe("fr");
  });

  it("says what is connected, and never how", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "user" });
    const { GET } = await import("@/app/api/config/public/route");
    const body = await (await GET(configReq())).json();
    expect(body).toEqual({
      defaultLang: "fr",
      playerEnabled: true,
      // Lu avant que le moindre lecteur soit monté : c'est lui qui dit lequel des deux existe.
      playerServerFallback: false,
      // L'option galerie, lue au démarrage et non plus figée dans l'image.
      claraGallery: false,
      configured: {
        radarr: true,
        sonarr: false,
        bazarr: false,
        jackett: false,
        jellyfin: false,
        jellyseerr: false,
        qbittorrent: false,
        tmdb: true,
      },
    });
    // Cette route est lue sans session : pas une adresse, pas une clé, rien qui puisse servir à
    // quelqu'un qui n'est pas encore connecté.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("abc");
    expect(raw).not.toContain("xyz");
    expect(raw).not.toContain("http");
  });
});

describe("POST /api/cache/invalidate", () => {
  it("returns 403 for a non-admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "user" });
    const { POST } = await import("@/app/api/cache/invalidate/route");
    const res = await POST(fakeReq());
    expect(res.status).toBe(403);
    expect(mockInvalidateLibrary).not.toHaveBeenCalled();
  });

  it("invalidates the library cache for an admin session", async () => {
    mockVerifySessionFull.mockResolvedValue({ role: "admin" });
    const { POST } = await import("@/app/api/cache/invalidate/route");
    const res = await POST(fakeReq());
    expect((await res.json()).ok).toBe(true);
    expect(mockInvalidateLibrary).toHaveBeenCalled();
  });
});
