import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

// L'écran d'accueil, côté serveur : un marqueur par compte, seul `louis` au départ, éteint par la
// fin de l'accueil, rallumé par l'administrateur.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-onboarding-"));
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getUsers: async () => [{ Id: "1", Name: "louis" }, { Id: "2", Name: "mathis" }] },
}));
vi.mock("@/lib/config", () => ({ config: { app: { adminUser: "admin" } } }));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const req = (body?: unknown) =>
  ({ cookies: { get: () => ({ value: "t" }) }, json: async () => body }) as unknown as NextRequest;

beforeEach(() => verify.mockReset());

describe("onboardingDb", () => {
  it("ne propose l'accueil qu'au compte de Louis au départ", async () => {
    const { onboardingDb } = await import("@/lib/db");
    expect(onboardingDb.isPending("louis")).toBe(true);
    expect(onboardingDb.isPending("mathis")).toBe(false);
  });
});

describe("/api/onboarding", () => {
  it("dit au compte connecté s'il a l'accueil à faire, et la fin l'éteint", async () => {
    verify.mockResolvedValue({ u: "louis", role: "admin" });
    const { GET, POST } = await import("@/app/api/onboarding/route");
    expect(await (await GET(req())).json()).toEqual({ pending: true });
    await POST(req());
    expect(await (await GET(req())).json()).toEqual({ pending: false });
  });

  it("refuse un visiteur sans session", async () => {
    verify.mockResolvedValue(null);
    const { GET, POST } = await import("@/app/api/onboarding/route");
    expect((await GET(req())).status).toBe(401);
    expect((await POST(req())).status).toBe(401);
  });
});

describe("/api/admin/onboarding", () => {
  it("est réservée à l'administrateur, lecture comprise", async () => {
    verify.mockResolvedValue({ u: "mathis", role: "user" });
    const { GET, PUT } = await import("@/app/api/admin/onboarding/route");
    expect((await GET(req())).status).toBe(403);
    expect((await PUT(req({ all: true, pending: true }))).status).toBe(403);
  });

  it("rallume un compte, puis tous, sur la liste de Jellyfin et le compte local", async () => {
    verify.mockResolvedValue({ u: "louis", role: "admin" });
    const { GET, PUT } = await import("@/app/api/admin/onboarding/route");
    await PUT(req({ user: "mathis", pending: true }));
    const one = await (await GET(req())).json();
    expect(one.accounts).toContainEqual({ name: "mathis", pending: true });
    expect(one.accounts.map((a: { name: string }) => a.name)).toEqual(["admin", "louis", "mathis"]);

    const all = await (await PUT(req({ all: true, pending: true }))).json();
    expect(all.accounts.every((a: { pending: boolean }) => a.pending)).toBe(true);
  });

  it("refuse un compte inconnu et une requête sans état", async () => {
    verify.mockResolvedValue({ u: "louis", role: "admin" });
    const { PUT } = await import("@/app/api/admin/onboarding/route");
    expect((await PUT(req({ user: "personne", pending: true }))).status).toBe(400);
    expect((await PUT(req({ user: "mathis" }))).status).toBe(400);
  });
});
