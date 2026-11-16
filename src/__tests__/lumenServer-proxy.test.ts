import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Lumen serveur au proxy (DECISIONS.md §156) : l'administrateur seul, lectures comprises ; un lien de
// partage n'y a pas de porte ; et — le point relevé par l'étude (2-serveur.md §2.5, risque 1) — un
// laissez-passer de diffusion, qui passe *avant* la vérification du rôle, ne s'applique pas à ces
// adresses : sans cookie, 401. Les routes le revérifient elles-mêmes (lumenServer-routes.test.ts).

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
const mockCast = vi.fn();
vi.mock("@/lib/castToken", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/castToken")>();
  // Un jeton toujours « valable » pour le titre qu'il nomme : seul `castItemOf` décide alors.
  return { ...real, castPassFor: async (req: Parameters<typeof real.castPassFor>[0]) => (real.castItemOf(req.nextUrl.pathname) ? mockCast() : null) };
});
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

const MOVIE = "a".repeat(32);
const PATHS = [
  `/api/lumen/${MOVIE}/eligibility`,
  `/api/lumen/${MOVIE}/1-0123456789ab/lecture/master.m3u8`,
  `/api/lumen/${MOVIE}/1-0123456789ab/lecture/v.m3u8`,
  `/api/lumen/${MOVIE}/1-0123456789ab/lecture/init-v.mp4`,
  `/api/lumen/${MOVIE}/1-0123456789ab/lecture/v/12.m4s`,
  `/api/lumen/${MOVIE}/1-0123456789ab/lecture/a2/12.m4s`,
];

function req(method: string, pathname: string, cookie = true): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers(method === "POST" ? { "sec-fetch-site": "same-origin" } : {}),
    cookies: { get: () => (cookie ? { value: "t" } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockCast.mockResolvedValue("louis");
  (await import("@/lib/share/scope")).__testing.reset();
});

describe("le proxy et /api/lumen", () => {
  it("refuse toute lecture et la préparation à un compte ordinaire", async () => {
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    const { proxy } = await import("@/proxy");
    for (const path of PATHS) expect((await proxy(req("GET", path))).status, path).toBe(403);
    expect((await proxy(req("POST", `/api/lumen/${MOVIE}/prepare`))).status).toBe(403);
  });

  it("laisse passer l'administrateur", async () => {
    mockVerify.mockResolvedValue({ u: "admin", role: "admin" });
    const { proxy } = await import("@/proxy");
    for (const path of PATHS) expect((await proxy(req("GET", path))).status, path).toBe(200);
    expect((await proxy(req("POST", `/api/lumen/${MOVIE}/prepare`))).status).toBe(200);
  });

  it("n'ouvre rien à un lien de partage, même pour son propre titre", async () => {
    mockVerify.mockResolvedValue({ u: "partage-01234567", jfUser: "partage-01234567", role: "share", sh: "0123456789abcdef", jti: "j", exp: Date.now() + 86_400_000 });
    const { proxy } = await import("@/proxy");
    for (const path of PATHS) expect((await proxy(req("GET", path))).status, path).not.toBe(200);
  });

  it("un laissez-passer de diffusion n'y vaut rien : sans cookie, 401", async () => {
    mockVerify.mockResolvedValue(null);
    const { proxy } = await import("@/proxy");
    for (const path of PATHS) {
      const res = await proxy(req("GET", `${path}?castToken=jeton`, false));
      expect(res.status, path).toBe(401);
    }
    expect(mockCast).not.toHaveBeenCalled();
    // Contre-épreuve : la même règle laisse bien passer le flux de diffusion qu'elle connaît.
    const stream = await proxy(req("GET", `/api/jellyfin/stream/${MOVIE}/main.m3u8?castToken=jeton`, false));
    expect(stream.status).toBe(200);
    expect(mockCast).toHaveBeenCalledTimes(1);
  });
});
