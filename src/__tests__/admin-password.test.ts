import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { hashAdminPassword, resetAdminPassword, verifyAdminPassword } from "../../server-boot/adminAccount.mjs";

describe("le mot de passe administrateur (module partagé)", () => {
  it("vérifie ce qu'il a haché, et rien d'autre", () => {
    const stored = hashAdminPassword("un-mot-de-passe");
    expect(verifyAdminPassword("un-mot-de-passe", stored)).toBe(true);
    expect(verifyAdminPassword("autre", stored)).toBe(false);
    expect(verifyAdminPassword("x", "n'importe quoi")).toBe(false);
  });

  it("la réinitialisation écrit un hachage que la connexion accepte, et garde le nom du compte", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-reset-"));
    const db = new Database(path.join(dir, "cine.db"));
    db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('__ADMIN_USER', 'gerant')").run();
    db.close();
    expect(await resetAdminPassword(dir, "nouveau-secret")).toBe("gerant");
    const check = new Database(path.join(dir, "cine.db"), { readonly: true });
    const hash = (check.prepare("SELECT value FROM app_settings WHERE key = '__ADMIN_PASSWORD_HASH'").get() as { value: string }).value;
    check.close();
    expect(verifyAdminPassword("nouveau-secret", hash)).toBe(true);
    await expect(resetAdminPassword(dir, "court")).rejects.toThrow();
  });
});

// La route : l'ancien mot de passe exigé, les autres sessions fermées, un compte du .env refusé.
const state = { admin: { user: "gerant", source: "setup" } as { user: string; source: string } | null, session: { role: "admin", jti: "moi" } as unknown };
const created: [string, string][] = [];
const deleted: string[] = [];
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => state.session }));
vi.mock("@/lib/rateLimiter", () => ({ checkRateLimit: () => true }));
vi.mock("@/lib/api-helpers", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/eventLogs", () => ({ logAuthEvent: vi.fn() }));
vi.mock("@/lib/db", () => ({
  sessionDb: { listOthers: () => [{ jti: "autre1" }, { jti: "autre2" }], delete: (jti: string) => void deleted.push(jti) },
}));
vi.mock("@/lib/settings/setup", () => ({
  MIN_ADMIN_PASSWORD: 8,
  localAdmin: () => state.admin,
  verifySetupAdmin: (_u: string, p: string) => p === "ancien-secret",
  createSetupAdmin: (u: string, p: string) => void created.push([u, p]),
}));

function req(body: unknown) {
  return { json: async () => body, cookies: { get: () => ({ value: "jeton" }) } } as never;
}

describe("POST /api/settings/admin-password", () => {
  beforeEach(() => {
    created.length = 0;
    deleted.length = 0;
    state.admin = { user: "gerant", source: "setup" };
    state.session = { role: "admin", jti: "moi" };
  });

  it("refuse un ancien mot de passe faux", async () => {
    const { POST } = await import("@/app/api/settings/admin-password/route");
    const res = await POST(req({ current: "faux", next: "nouveau-secret" }));
    expect(res.status).toBe(400);
    expect(created).toEqual([]);
  });

  it("change le mot de passe et ferme les autres sessions du compte", async () => {
    const { POST } = await import("@/app/api/settings/admin-password/route");
    const res = await POST(req({ current: "ancien-secret", next: "nouveau-secret" }));
    expect(res.status).toBe(200);
    expect(created).toEqual([["gerant", "nouveau-secret"]]);
    expect(deleted).toEqual(["autre1", "autre2"]);
  });

  it("renvoie au .env un compte fixé par APP_ADMIN_PASSWORD", async () => {
    state.admin = { user: "admin", source: "env" };
    const { POST } = await import("@/app/api/settings/admin-password/route");
    const res = await POST(req({ current: "ancien-secret", next: "nouveau-secret" }));
    expect(res.status).toBe(409);
  });

  it("refuse un compte qui n'est pas administrateur", async () => {
    state.session = { role: "user", jti: "x" };
    const { POST } = await import("@/app/api/settings/admin-password/route");
    expect((await POST(req({ current: "ancien-secret", next: "nouveau-secret" }))).status).toBe(403);
  });
});
