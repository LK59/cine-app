import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import { signSalonsPass } from "@/lib/salons/pass";
import { salonsRelayTarget } from "@/lib/salons/relay";
// Le code du service lui-même (`salons/src/pass.ts`, sans dépendance) : ce que l'application signe, il doit
// l'accepter — et le vecteur partagé doit donner le même jeton des deux côtés.
import { PASS_TEST_VECTOR, verifyPass } from "../../salons/src/pass";

const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const salons = { audience: "tous" as "off" | "admins" | "tous", url: "http://laterna-salons:8090", key: "k".repeat(40) };
vi.mock("@/lib/config", () => ({ config: { salons } }));

const req = { cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) } } as unknown as NextRequest;
const get = async () => {
  const { GET } = await import("@/app/api/salons/pass/route");
  const res = await GET(req);
  return { status: res.status, body: (await res.json()) as { available: boolean; pass?: string; socket?: string } };
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(salons, { audience: "tous", url: "http://laterna-salons:8090", key: "k".repeat(40) });
  mockVerifySessionFull.mockResolvedValue({ u: "marie", jfUser: "Marie", jfId: "jf-123", role: "user" });
});

/**
 * Le laissez-passer des salons du chalet (DECISIONS.md §146) : signé ici, vérifié par le service, même format des
 * deux côtés ; et la route qui le délivre ne dit jamais « 404 » ni « 403 » — `available: false` quand ce n'est pas
 * pour cette session.
 */
describe("le laissez-passer des salons", () => {
  it("le vecteur partagé : l'application signe exactement ce que le service attend", () => {
    expect(signSalonsPass(PASS_TEST_VECTOR.claims, PASS_TEST_VECTOR.key)).toBe(PASS_TEST_VECTOR.token);
  });

  it("délivré à un compte du foyer : vérifié par le code du service, avec son identité ; le relais connaît l'adresse", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ available: true, socket: "/api/salons/ws" });
    const claims = verifyPass(body.pass!, salons.key);
    expect(claims).toMatchObject({ sub: "jf-123", name: "Marie", admin: false });
    expect(claims!.exp - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(salonsRelayTarget()).toEqual({ url: "http://laterna-salons:8090" });
  });

  it("coupé, réservé aux administrateurs, clé trop courte, lien de partage : 200 et « indisponible », relais vidé", async () => {
    for (const setup of [
      () => (salons.audience = "off"),
      () => (salons.audience = "admins"),
      () => (salons.key = "courte"),
      () => mockVerifySessionFull.mockResolvedValue({ u: "lien", role: "share", sh: "abc" }),
    ]) {
      Object.assign(salons, { audience: "tous", key: "k".repeat(40) });
      mockVerifySessionFull.mockResolvedValue({ u: "marie", jfUser: "Marie", jfId: "jf-123", role: "user" });
      setup();
      const { status, body } = await get();
      expect(status).toBe(200);
      expect(body).toEqual({ available: false });
      expect(salonsRelayTarget()).toBeNull();
    }
  });

  it("réservé aux administrateurs : un administrateur l'obtient, marqué comme tel ; le compte local a un identifiant à lui", async () => {
    salons.audience = "admins";
    mockVerifySessionFull.mockResolvedValue({ u: "admin", role: "admin" });
    const { body } = await get();
    expect(verifyPass(body.pass!, salons.key)).toMatchObject({ sub: "local:admin", name: "admin", admin: true });
  });

  it("sans session (révoquée entre le portail et la route) : 401, sans l'en-tête que seul le portail pose", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    const { GET } = await import("@/app/api/salons/pass/route");
    const res = await GET(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-session-expired")).toBeNull();
  });
});
