import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Le proxy prolonge désormais une session qui a vieilli : il lui faut de quoi décider et de
// quoi réémettre. Ici, rien n'a jamais assez vieilli — ces tests parlent d'autre chose.
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
  mockVerify.mockResolvedValue({ u: "mathis", role: "user" });
});

describe("proxy — what a plain user may write", () => {
  // Ces routes ont été écrites après la liste blanche et n'y figuraient pas : côté utilisateur,
  // « Demander », le cœur des favoris, les préférences de lecture et le mot de passe répondaient
  // tous 403. Invisible en administrateur, donc invisible pour celui qui teste.
  it("lets a user act on their own account and their own lists", async () => {
    const { proxy } = await import("@/proxy");
    for (const [method, path] of [
      ["POST", "/api/player/requests"],
      ["POST", "/api/jellyfin/favorite"],
      ["POST", "/api/player/account/preferences"],
      ["POST", "/api/player/account/password"],
      ["POST", "/api/watchlist"],
      // Les deux boutons du panneau « Compte » que tout le monde voit : l'interrupteur de
      // notifications et « déconnecter mes autres appareils ». Ils répondaient 403 à un compte
      // ordinaire, ce qui ne se voit pas quand on teste en administrateur.
      ["POST", "/api/push/subscribe"],
      ["DELETE", "/api/push/subscribe"],
      ["DELETE", "/api/auth/sessions"],
    ] as const) {
      const res = await proxy(req(method, path));
      expect([method, path, res.status]).toEqual([method, path, 200]);
    }
  });

  it("lets a user cancel their own request and ask for a missing episode", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("DELETE", "/api/player/requests/328"))).status).toBe(200);
    expect((await proxy(req("POST", "/api/player/series/42/search"))).status).toBe(200);
  });

  // Les motifs restent étroits : un identifiant numérique, et rien qui puisse glisser vers un
  // sous-chemin voisin.
  it("keeps the patterns narrow", async () => {
    const { proxy } = await import("@/proxy");
    for (const path of [
      "/api/player/requests/328/approve",
      "/api/player/series/42/search/all",
      "/api/player/series/abc/search",
      "/api/sonarr/series",
    ]) {
      expect((await proxy(req("POST", path))).status).toBe(403);
    }
  });

  it("still blocks everything else a user has no business writing", async () => {
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("DELETE", "/api/radarr/movies/12"))).status).toBe(403);
    expect((await proxy(req("POST", "/api/qbittorrent/pause"))).status).toBe(403);
  });

  it("leaves an administrator alone", async () => {
    mockVerify.mockResolvedValue({ u: "louis", role: "admin" });
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("DELETE", "/api/radarr/movies/12"))).status).toBe(200);
  });
});
