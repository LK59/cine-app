import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { HttpError } from "@/lib/http";

/**
 * Un jeton Jellyfin révoqué derrière une session encore valide (24/09/2026) : un compte dont le mot
 * de passe avait été réinitialisé a regardé deux films en entier sans qu'une seconde en soit gardée,
 * chaque rapport refusé en silence. Trois choses le couvrent désormais, éprouvées ici.
 */

const mockJellyfin = {
  checkUserToken: vi.fn(),
  savePositionAsAdmin: vi.fn(),
  markPlayed: vi.fn(),
  getRunTimeTicks: vi.fn(),
};
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
const mockLog = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => mockLog(...a) }));

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
}));
const mockSessionDb = { touch: vi.fn(), delete: vi.fn() };
vi.mock("@/lib/db", () => ({ sessionDb: mockSessionDb }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

const SESSION = { u: "raphael", jfUser: "raphael", role: "user" as const, jti: "s-1", jfId: "jf-1", jfToken: "mort", exp: 0 };
const refused = () => new HttpError("401 Unauthorized: ", 401);

function req(pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method: "GET", cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  (await import("@/lib/jellyfinToken")).__testing.reset();
});

describe("jellyfinTokenAlive", () => {
  it("conclut au jeton mort sur un 401, l'écrit une fois, et ne redemande plus", async () => {
    mockJellyfin.checkUserToken.mockRejectedValue(refused());
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(SESSION)).toBe(false);
    expect(await jellyfinTokenAlive(SESSION)).toBe(false);
    expect(mockJellyfin.checkUserToken).toHaveBeenCalledTimes(1);
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0]).toBe("jellyfin-token");
    expect(mockLog.mock.calls[0][2]).toMatchObject({ user: "raphael" });
  });

  it("ne conclut rien d'un Jellyfin absent : un redémarrage du serveur ne déconnecte personne", async () => {
    mockJellyfin.checkUserToken.mockRejectedValue(new Error("fetch failed"));
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(SESSION)).toBe(true);
    mockJellyfin.checkUserToken.mockRejectedValue(new HttpError("503", 503));
    expect(await jellyfinTokenAlive({ ...SESSION, jti: "s-2" })).toBe(true);
  });

  it("pose la question au plus une fois par heure pour un jeton accepté", async () => {
    mockJellyfin.checkUserToken.mockResolvedValue({ Id: "jf-1" });
    const { jellyfinTokenAlive } = await import("@/lib/jellyfinToken");
    expect(await jellyfinTokenAlive(SESSION)).toBe(true);
    expect(await jellyfinTokenAlive(SESSION)).toBe(true);
    expect(mockJellyfin.checkUserToken).toHaveBeenCalledTimes(1);
  });
});

describe("proxy — un jeton Jellyfin révoqué", () => {
  it("ferme la session au chargement d'une page et renvoie à la connexion", async () => {
    mockVerify.mockResolvedValue(SESSION);
    mockJellyfin.checkUserToken.mockRejectedValue(refused());
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("reason")).toBe("jellyfin");
    expect(mockSessionDb.delete).toHaveBeenCalledWith("s-1");
  });

  // Fermer la session sur une route d'API couperait aussi le flux d'un film en cours.
  it("ne touche à rien sur une route d'API, pas même la question", async () => {
    mockVerify.mockResolvedValue(SESSION);
    mockJellyfin.checkUserToken.mockRejectedValue(refused());
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/api/jellyfin/stream/abc"));
    expect(res.status).toBe(200);
    expect(mockJellyfin.checkUserToken).not.toHaveBeenCalled();
    expect(mockSessionDb.delete).not.toHaveBeenCalled();
  });

  it("laisse passer la page quand Jellyfin ne répond pas", async () => {
    mockVerify.mockResolvedValue(SESSION);
    mockJellyfin.checkUserToken.mockRejectedValue(new Error("fetch failed"));
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/"));
    expect(res.status).toBe(200);
    expect(mockSessionDb.delete).not.toHaveBeenCalled();
  });
});

describe("reportPlayback — un rapport refusé garde la position autrement", () => {
  const send = () => Promise.reject(refused());

  it("écrit la progression avec la clé d'administration, et le film continue (200)", async () => {
    const { reportPlayback } = await import("@/lib/playbackReport");
    const res = await reportPlayback(SESSION, "progress", "film", 1234e7, send);
    expect(res.status).toBe(200);
    expect(mockJellyfin.savePositionAsAdmin).toHaveBeenCalledWith("jf-1", "film", 1234e7);
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it("marque vu un arrêt au-delà de 90 %, comme Jellyfin", async () => {
    mockJellyfin.getRunTimeTicks.mockResolvedValue(7466e7);
    const { reportPlayback } = await import("@/lib/playbackReport");
    await reportPlayback(SESSION, "stop", "film", 7233e7, send);
    expect(mockJellyfin.markPlayed).toHaveBeenCalledWith("jf-1", "film");
    expect(mockJellyfin.savePositionAsAdmin).not.toHaveBeenCalled();
  });

  it("garde la position d'un arrêt en cours de film", async () => {
    mockJellyfin.getRunTimeTicks.mockResolvedValue(7466e7);
    const { reportPlayback } = await import("@/lib/playbackReport");
    await reportPlayback(SESSION, "stop", "film", 2076e7, send);
    expect(mockJellyfin.savePositionAsAdmin).toHaveBeenCalledWith("jf-1", "film", 2076e7);
  });

  it("laisse toute autre erreur en 502, sans rien écrire à la place", async () => {
    const { reportPlayback } = await import("@/lib/playbackReport");
    const res = await reportPlayback(SESSION, "progress", "film", 1, () => Promise.reject(new HttpError("500", 500)));
    expect(res.status).toBe(502);
    expect(mockJellyfin.savePositionAsAdmin).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });
});
