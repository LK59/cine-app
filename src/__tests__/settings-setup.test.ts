import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Le déploiement simplifié (DECISIONS.md §48) : réglages faits dans l'application, `.env` en
 * repli, assistant de premier lancement. Un dossier de données à ce fichier seul — un réglage écrit
 * ici ne doit jamais déborder sur les autres tests (ils partagent le dossier de la suite).
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-settings-"));
type Setup = typeof import("@/lib/settings/setup");
type Store = typeof import("@/lib/settings/store");
type Config = typeof import("@/lib/config");
let setup: Setup;
let store: Store;
let configModule: Config;
const saved = { ...process.env };

beforeAll(async () => {
  vi.resetModules();
  process.env.DATA_DIR = dir;
  store = await import("@/lib/settings/store");
  setup = await import("@/lib/settings/setup");
  configModule = await import("@/lib/config");
});
beforeEach(() => {
  for (const k of ["JELLYFIN_URL", "JELLYFIN_API_KEY", "TMDB_API_KEY", "RADARR_API_KEY", "SONARR_API_KEY", "APP_ADMIN_PASSWORD", "APP_ADMIN_USER", "SETUP_COMPLETE"]) delete process.env[k];
  fs.rmSync(path.join(dir, "cine.db"), { force: true });
  fs.rmSync(path.join(dir, "cine.db-wal"), { force: true });
  fs.rmSync(path.join(dir, "cine.db-shm"), { force: true });
  store.resetSettingsStoreForTests();
});
afterAll(() => {
  process.env = saved;
});

describe("une valeur de réglage", () => {
  it("vient de l'application d'abord, de .env ensuite, du défaut enfin — et config la suit en direct", () => {
    expect(setup.settingValue("JELLYFIN_URL")).toBe("http://jellyfin:8096");
    expect(setup.settingSource("JELLYFIN_URL")).toBe("default");
    process.env.JELLYFIN_URL = "http://env:8096";
    expect(configModule.config.jellyfin.url).toBe("http://env:8096");
    expect(setup.saveSettings({ JELLYFIN_URL: "http://app:8096" }).errors).toEqual({});
    expect(configModule.config.jellyfin.url).toBe("http://app:8096");
    expect(setup.settingView("JELLYFIN_URL")).toMatchObject({ source: "app", envPresent: true, value: "http://app:8096" });
    // « Revenir à la valeur du .env »
    expect(setup.resetSetting("JELLYFIN_URL")).toBe(true);
    expect(configModule.config.jellyfin.url).toBe("http://env:8096");
  });

  it("ne renvoie jamais un secret, seulement qu'il est renseigné et ses quatre derniers caractères", () => {
    setup.saveSettings({ TMDB_API_KEY: "abcdef0123456789" });
    expect(setup.settingView("TMDB_API_KEY")).toMatchObject({ value: null, set: true, hint: "…6789", source: "app" });
  });

  it("refuse tout si une valeur est fausse, et laisse un secret vide intact", () => {
    setup.saveSettings({ RADARR_API_KEY: "clé-radarr" });
    const { errors } = setup.saveSettings({ RADARR_URL: "pas une adresse", RADARR_API_KEY: "autre" });
    expect(errors).toEqual({ RADARR_URL: "invalid-url" });
    expect(setup.settingValue("RADARR_API_KEY")).toBe("clé-radarr");
    setup.saveSettings({ RADARR_API_KEY: "" });
    expect(setup.settingValue("RADARR_API_KEY")).toBe("clé-radarr");
    expect(setup.saveSettings({ SESSION_SECRET: "x" }).errors).toEqual({ SESSION_SECRET: "unknown" });
  });
});

describe("l'assistant de premier lancement", () => {
  it("est ouvert sur une installation neuve, et liste ce qui manque", () => {
    expect(setup.setupDone()).toBe(false);
    expect(setup.missingRequiredSettings()).toEqual(["JELLYFIN_API_KEY", "TMDB_API_KEY", "RADARR_API_KEY|SONARR_API_KEY"]);
  });

  it("reconnaît une installation déjà configurée par son .env, et ne la rouvre plus ensuite", () => {
    process.env.JELLYFIN_API_KEY = "j";
    process.env.TMDB_API_KEY = "t";
    process.env.SONARR_API_KEY = "s";
    expect(setup.setupDone()).toBe(true);
    delete process.env.JELLYFIN_API_KEY;
    expect(setup.setupDone()).toBe(true); // le drapeau a été posé une fois pour toutes
  });

  it("se termine par son drapeau", () => {
    setup.saveSettings({ JELLYFIN_API_KEY: "j", TMDB_API_KEY: "t", RADARR_API_KEY: "r" });
    expect(setup.missingRequiredSettings()).toEqual([]);
    setup.completeSetup();
    expect(setup.setupDone()).toBe(true);
  });
});

describe("le compte administrateur", () => {
  it("n'existe pas au premier lancement ; celui de l'assistant est gardé haché", () => {
    expect(setup.localAdmin()).toBeNull();
    setup.createSetupAdmin("louis", "un-mot-de-passe");
    expect(setup.localAdmin()).toEqual({ user: "louis", source: "setup" });
    expect(setup.verifySetupAdmin("louis", "un-mot-de-passe")).toBe(true);
    expect(setup.verifySetupAdmin("louis", "mauvais")).toBe(false);
    expect(setup.verifySetupAdmin("autre", "un-mot-de-passe")).toBe(false);
    expect(store.readOverride("__ADMIN_PASSWORD_HASH")).not.toContain("un-mot-de-passe");
  });

  it("celui de .env l'emporte", () => {
    process.env.APP_ADMIN_PASSWORD = "secret-env";
    process.env.APP_ADMIN_USER = "chef";
    expect(setup.localAdmin()).toEqual({ user: "chef", source: "env" });
  });
});
