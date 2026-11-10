import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Le mode « Immersion » n'est dans aucune liste publique : sans session, rien n'en sort.
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn(), delete: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
const mockShareGate = vi.fn();
vi.mock("@/lib/share/gate", () => ({ shareGate: (...a: unknown[]) => mockShareGate(...a) }));
vi.mock("@/lib/share/store", () => ({ sharesDb: { get: () => null } }));

function req(pathname: string, cookie: string | null): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: "GET",
    headers: new Headers(),
    cookies: { get: () => (cookie ? { value: cookie } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proxy — le mode Immersion", () => {
  it("renvoie la page à la connexion sans session, avec le chemin du retour", async () => {
    mockVerify.mockResolvedValue(null);
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/immersion", null));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/immersion");
  });

  // Une adresse sous `/api/` ne redirige jamais vers une page : le proxy répond 401, marqué
  // « session finie » — c'est ce que la page du mode sait lire. Rien n'est servi dans les deux cas.
  it("refuse ses fichiers sans session", async () => {
    mockVerify.mockResolvedValue(null);
    const { proxy } = await import("@/proxy");
    for (const path of ["/api/immersion/app/index-Dk3fA91b.js", "/api/immersion/poster.jpg", "/api/immersion/assets/textures/wood_floor/color.ktx2"]) {
      const res = await proxy(req(path, null));
      expect(res.status, path).toBe(401);
      expect(res.headers.get("x-session-expired"), path).toBe("1");
    }
  });

  it("n'est dans aucune liste publique, et passe par le proxy", async () => {
    const { isPublicPath } = await import("@/lib/publicPaths");
    const { config } = await import("@/proxy");
    expect(isPublicPath("/immersion")).toBe(false);
    expect(isPublicPath("/api/immersion/poster.jpg")).toBe(false);
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    expect(matcher.test("/immersion")).toBe(true);
    expect(matcher.test("/api/immersion/poster.jpg")).toBe(true);
  });

  it("ouvre la page et ses fichiers à un compte ordinaire", async () => {
    mockVerify.mockResolvedValue({ u: "spectateur", role: "user", jti: "a", jfId: "abc" });
    const { proxy } = await import("@/proxy");
    for (const path of ["/immersion", "/api/immersion/poster.jpg"]) {
      const res = await proxy(req(path, "t"));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  // Un lien de partage a sa propre porte, fermée par défaut : c'est elle qui répond, pas les règles des comptes.
  it("laisse la porte des liens de partage décider pour un invité", async () => {
    mockVerify.mockResolvedValue({ u: "invité", role: "share", jti: "s", sh: "lien", exp: 0 });
    const { NextResponse } = await import("next/server");
    mockShareGate.mockResolvedValue(NextResponse.json({ error: "refusé" }, { status: 403 }));
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/immersion", "t"));
    expect(mockShareGate).toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});
