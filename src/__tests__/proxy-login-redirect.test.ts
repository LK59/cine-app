import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Rien n'a jamais assez vieilli ici : ces tests parlent de l'écran de connexion, pas du
// renouvellement de session.
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

function req(pathname: string, search = ""): NextRequest {
  const url = new URL(`https://cine.example${pathname}${search}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: "GET",
    cookies: { get: () => ({ value: "t" }) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proxy — /login avec une session valide", () => {
  // Le symptôme : revenir de la page d'état des services affichait un formulaire de connexion à
  // quelqu'un qui n'avait jamais cessé d'être connecté.
  it("renvoie une session Jellyfin vers la racine", async () => {
    mockVerify.mockResolvedValue({ u: "louis", role: "user", jti: "a", jfId: "abc" });
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/login"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://cine.example/");
  });

  // Une session locale n'a pas d'identité Jellyfin : le lecteur qu'on lui ouvrirait aurait un
  // bouton « Lire » qui répond 401. C'est le raisonnement que l'écran de connexion tient déjà
  // pour sa propre redirection après identification.
  it("renvoie une session locale vers la gestion", async () => {
    mockVerify.mockResolvedValue({ u: "louis", role: "admin", jti: "a" });
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/login"));
    expect(res.headers.get("location")).toBe("https://cine.example/gestion");
  });

  it("laisse l'écran de connexion s'afficher sans session", async () => {
    mockVerify.mockResolvedValue(null);
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/login", "?next=%2Fgestion"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  // La page de connexion est la porte d'entrée : une garde qui lève à sa place la remplacerait
  // par une erreur, le jour précisément où l'on a besoin d'elle.
  it("affiche le formulaire plutôt qu'une erreur si la vérification échoue", async () => {
    mockVerify.mockRejectedValue(new Error("base indisponible"));
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/login"));
    expect(res.status).toBe(200);
  });

  // La route d'identification porte le même préfixe et ne doit surtout pas être redirigée : c'est
  // elle qui pose le cookie.
  it("ne touche pas à POST /api/auth/login", async () => {
    mockVerify.mockResolvedValue({ u: "louis", role: "admin", jti: "a", jfId: "abc" });
    const { proxy } = await import("@/proxy");
    const res = await proxy(req("/api/auth/login"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
