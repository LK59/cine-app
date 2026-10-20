import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Une adresse changée ne reçoit jamais le secret enregistré (20/10/2026). Un secret laissé vide
 * reprend celui qui est gardé — au test comme à l'enregistrement — et changer la seule adresse
 * envoyait alors la clé d'administration de Jellyfin, Radarr… à l'hôte saisi : un cookie
 * administrateur volé devenait le vol de toutes les clés. Il faut désormais la ressaisir.
 */

vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/settings-secret-url-`);
});

const logged = vi.hoisted(() => [] as { admin: string; action: string; context: Record<string, unknown> }[]);
vi.mock("@/lib/server-cache", () => ({ invalidateByPrefix: () => {} }));
vi.mock("@/lib/logger", async (orig) => ({
  ...(await orig<typeof import("@/lib/logger")>()),
  logAdminAction: (admin: string, action: string, context: Record<string, unknown>) => logged.push({ admin, action, context }),
}));

import { PUT } from "@/app/api/settings/route";
import { POST as TEST } from "@/app/api/settings/test/route";
import { normalizeServiceUrl, saveSettings, secretsToResubmit, settingValue } from "@/lib/settings/setup";
import { deleteOverride } from "@/lib/settings/store";

const KEYS = ["RADARR_URL", "RADARR_API_KEY", "QBITTORRENT_URL", "QBITTORRENT_PASSWORD", "JELLYFIN_URL", "JELLYFIN_API_KEY"];

const put = (values: Record<string, string>) => ({ json: async () => ({ values }) }) as unknown as NextRequest;
const test = (group: string, values: Record<string, string>) => ({ json: async () => ({ group, values }) }) as unknown as NextRequest;

beforeEach(() => {
  for (const k of KEYS) {
    delete process.env[k];
    deleteOverride(k);
  }
  logged.length = 0;
  expect(saveSettings({ RADARR_URL: "http://radarr:7878", RADARR_API_KEY: "cle-radarr-enregistree" }).errors).toEqual({});
});
afterEach(() => vi.unstubAllGlobals());

describe("la comparaison des adresses", () => {
  it("ignore espaces, barre finale et casse du schéma et de l'hôte — pas celle du chemin", () => {
    expect(normalizeServiceUrl(" HTTP://Radarr:7878/ ")).toBe(normalizeServiceUrl("http://radarr:7878"));
    expect(normalizeServiceUrl("http://radarr:7878/Base/")).toBe("http://radarr:7878/Base");
    expect(normalizeServiceUrl("http://radarr:7878/Base")).not.toBe(normalizeServiceUrl("http://radarr:7878/base"));
    expect(normalizeServiceUrl("http://evil.example:7878")).not.toBe(normalizeServiceUrl("http://radarr:7878"));
  });
});

describe("l'enregistrement", () => {
  it("refuse une adresse nouvelle sans la clé, et n'écrit rien", async () => {
    const res = await PUT(put({ RADARR_URL: "http://evil.example:7878" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "settings-secret-required", fields: ["RADARR_API_KEY"], errors: { RADARR_API_KEY: "secret-required" } });
    expect(settingValue("RADARR_URL")).toBe("http://radarr:7878");
    // Un secret vide envoyé explicitement ne compte pas comme ressaisi.
    expect(saveSettings({ RADARR_URL: "http://evil.example:7878", RADARR_API_KEY: "  " }).errors).toEqual({ RADARR_API_KEY: "secret-required" });
    expect(logged).toEqual([]);
  });

  it("accepte l'adresse nouvelle avec la clé ressaisie, et le note au journal sans le secret", async () => {
    const res = await PUT(put({ RADARR_URL: "http://user:pw@radarr2:7878/", RADARR_API_KEY: "nouvelle-cle" }));
    expect(res.status).toBe(200);
    expect(settingValue("RADARR_API_KEY")).toBe("nouvelle-cle");
    expect(logged).toHaveLength(1);
    expect(logged[0].context).toEqual({ setting: "RADARR_URL", from: "http://radarr:7878", to: "http://radarr2:7878" });
    expect(JSON.stringify(logged)).not.toMatch(/nouvelle-cle|cle-radarr|pw/);
  });

  it("garde la règle d'avant pour une adresse inchangée (à la casse et à la barre près)", async () => {
    expect((await PUT(put({ RADARR_URL: "HTTP://Radarr:7878/" }))).status).toBe(200);
    expect(settingValue("RADARR_API_KEY")).toBe("cle-radarr-enregistree");
    expect(logged).toEqual([]);
  });

  it("ne demande rien quand aucun secret n'est encore enregistré (l'assistant d'une installation neuve)", () => {
    expect(saveSettings({ JELLYFIN_URL: "http://mon-jellyfin:8096" }).errors).toEqual({});
  });

  it("couvre aussi le mot de passe de qBittorrent, et une clé venue de .env", () => {
    process.env.QBITTORRENT_PASSWORD = "mdp-env";
    process.env.JELLYFIN_API_KEY = "cle-env";
    expect(saveSettings({ QBITTORRENT_URL: "http://ailleurs:8080" }).errors).toEqual({ QBITTORRENT_PASSWORD: "secret-required" });
    expect(saveSettings({ JELLYFIN_URL: "http://ailleurs:8096" }).errors).toEqual({ JELLYFIN_API_KEY: "secret-required" });
    expect(secretsToResubmit((k) => (k === "JELLYFIN_URL" ? "http://jellyfin:8096/" : ""))).toEqual({ missing: [], changed: [] });
  });
});

describe("« Tester la connexion »", () => {
  it("n'envoie jamais la clé enregistrée à une adresse nouvelle", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await TEST(test("radarr", { RADARR_URL: "http://evil.example:7878" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, detail: "secret-required", code: "settings-secret-required", fields: ["RADARR_API_KEY"] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("teste l'adresse nouvelle avec la clé saisie, et l'adresse inchangée avec la clé enregistrée", async () => {
    const seen: { url: string; key: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ url, key: new Headers(init?.headers).get("x-api-key") });
        return new Response(JSON.stringify({ appName: "Radarr", version: "5" }), { status: 200 });
      }),
    );
    expect((await TEST(test("radarr", { RADARR_URL: "http://radarr2:7878", RADARR_API_KEY: "saisie" }))).status).toBe(200);
    expect((await TEST(test("radarr", { RADARR_URL: "http://radarr:7878/" }))).status).toBe(200);
    expect(seen).toEqual([
      { url: "http://radarr2:7878/api/v3/system/status", key: "saisie" },
      { url: "http://radarr:7878/api/v3/system/status", key: "cle-radarr-enregistree" },
    ]);
  });
});
