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

function req(pathname: string, hash = ""): NextRequest {
  const url = new URL(`https://cine.example${pathname}${hash}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: "GET",
    cookies: { get: () => ({ value: "t" }) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ u: "louis", role: "admin" });
});

describe("proxy — moved paths", () => {
  // La redirection est faite ici et non par la page : `redirect()` dans un composant serveur
  // imbriqué renvoie une page complète (la coquille de gestion a déjà commencé à partir), donc un
  // éclair de barre latérale avant d'arriver au lecteur.
  it("sends the old cinema address to the player, permanently", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/cinema"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://cine.example/player");
    // Rien n'a besoin d'être vérifié en session pour une adresse qui a simplement déménagé.
    expect(mockVerify).not.toHaveBeenCalled();
  });

  // En pratique un navigateur n'envoie pas le fragment et le réapplique tout seul après une
  // redirection qui n'en porte pas ; ce test fige simplement le fait qu'on ne le jette pas si
  // quelque chose venait à le transmettre.
  it("keeps the hash across the move when one is present", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/cinema", "#film=42"));
    expect(res.headers.get("location")).toBe("https://cine.example/player#film=42");
  });

  it("leaves every other path alone", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/player"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
