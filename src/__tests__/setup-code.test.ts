import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import type { NextRequest } from "next/server";

/**
 * Le code d'installation (20/10/2026) : sur une installation neuve, la route qui crée le compte
 * administrateur est publique, et le premier visiteur en devenait l'administrateur. Elle exige
 * désormais un code tiré au démarrage et écrit dans les seuls journaux du conteneur.
 */

vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/setup-code-`);
});

// La session ouverte après la création n'est pas l'objet ici.
vi.mock("@/lib/adminSession", () => ({
  adminSessionResponse: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
}));
const limit = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/rateLimiter", () => ({ checkRateLimit: () => limit.ok }));

import { POST } from "@/app/api/setup/admin/route";
import { announceSetupCode, ensureSetupCode, setupCodeFile, setupCodeLogLine, verifySetupCode } from "@/lib/settings/setupCode";
import { localAdmin, reopenSetupForTests, completeSetup } from "@/lib/settings/setup";
import { deleteOverride } from "@/lib/settings/store";

const post = (body: Record<string, unknown>) =>
  ({ json: async () => body, headers: new Headers(), cookies: { get: () => undefined } }) as unknown as NextRequest;

beforeEach(() => {
  for (const k of ["APP_ADMIN_PASSWORD", "APP_ADMIN_USER", "SETUP_COMPLETE", "JELLYFIN_API_KEY", "TMDB_API_KEY"]) delete process.env[k];
  deleteOverride("__ADMIN_PASSWORD_HASH");
  deleteOverride("__ADMIN_USER");
  reopenSetupForTests();
  fs.rmSync(setupCodeFile(), { force: true });
  limit.ok = true;
});

describe("le code d'installation", () => {
  it("est tiré une fois, gardé lisible du seul conteneur, et écrit aux journaux à chaque démarrage", () => {
    const lines: string[] = [];
    announceSetupCode((l) => lines.push(l));
    announceSetupCode((l) => lines.push(l));
    const code = fs.readFileSync(setupCodeFile(), "utf8").trim();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(fs.statSync(setupCodeFile()).mode & 0o777).toBe(0o600);
    expect(lines).toEqual([setupCodeLogLine(code), setupCodeLogLine(code)]);
    expect(lines[0]).toBe(`[setup] One-time setup code: ${code} — enter it in the setup assistant to create the administrator account (valid until that account exists).`);
  });

  it("se recopie sans souci de casse, d'espaces ni de tirets ; rien d'autre ne passe", () => {
    const { code } = ensureSetupCode()!;
    expect(verifySetupCode(code)).toBe(true);
    expect(verifySetupCode(` ${code.toLowerCase().replace(/-/g, " ")} `)).toBe(true);
    expect(verifySetupCode(code.slice(0, -1) + (code.endsWith("A") ? "B" : "A"))).toBe(false);
    expect(verifySetupCode("")).toBe(false);
    expect(verifySetupCode(undefined)).toBe(false);
    expect(verifySetupCode(12)).toBe(false);
  });

  it("n'existe pas — et rien n'est écrit aux journaux — quand un administrateur existe déjà", () => {
    process.env.APP_ADMIN_PASSWORD = "secret-env-assez-long";
    const lines: string[] = [];
    announceSetupCode((l) => lines.push(l));
    expect(lines).toEqual([]);
    expect(fs.existsSync(setupCodeFile())).toBe(false);
  });

  it("n'existe pas sur une installation dont l'assistant est terminé, et un code resté est effacé", () => {
    ensureSetupCode();
    completeSetup();
    expect(ensureSetupCode()).toBeNull();
    expect(fs.existsSync(setupCodeFile())).toBe(false);
  });
});

describe("POST /api/setup/admin", () => {
  it("refuse sans le code, ou avec un faux, sans rien créer", async () => {
    ensureSetupCode();
    const none = await POST(post({ username: "admin", password: "un-mot-de-passe" }));
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ error: "invalid-setup-code" });
    expect((await POST(post({ setupCode: "AAAA-AAAA-AAAA", username: "admin", password: "un-mot-de-passe" }))).status).toBe(403);
    expect(localAdmin()).toBeNull();
  });

  it("crée le compte avec le bon code, puis le code disparaît", async () => {
    const { code } = ensureSetupCode()!;
    const res = await POST(post({ setupCode: code, username: "admin", password: "un-mot-de-passe" }));
    expect(res.status).toBe(200);
    expect(localAdmin()).toEqual({ user: "admin", source: "setup" });
    expect(fs.existsSync(setupCodeFile())).toBe(false);
    // Le même code ne rouvre rien.
    expect((await POST(post({ setupCode: code, username: "autre", password: "un-mot-de-passe" }))).status).toBe(409);
  });

  it("tire le code s'il manque et le dit aux journaux, sans l'accepter de qui ne l'a pas lu", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(post({ setupCode: "", username: "admin", password: "un-mot-de-passe" }));
    expect(res.status).toBe(403);
    const code = fs.readFileSync(setupCodeFile(), "utf8").trim();
    expect(log).toHaveBeenCalledWith(setupCodeLogLine(code));
    log.mockRestore();
  });

  it("reste limité en tentatives", async () => {
    limit.ok = false;
    expect((await POST(post({ setupCode: "x", username: "admin", password: "un-mot-de-passe" }))).status).toBe(429);
  });
});
