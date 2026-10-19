import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SETTINGS } from "@/lib/settings/schema";

/**
 * La configuration complète dans l'application (DECISIONS.md §48, §81) : chaque réglage du schéma
 * se lit dans l'ordre réglage de l'application → `.env` → défaut, **à chaque accès** (un réglage
 * changé dans la Configuration s'applique sans redémarrer) ; ce qui n'est pas réglable d'ici ne
 * se laisse ni écrire par l'interface, ni changer par une ligne restée en base.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-settings-config-"));
type Setup = typeof import("@/lib/settings/setup");
type Store = typeof import("@/lib/settings/store");
type Config = typeof import("@/lib/config");
let setup: Setup;
let store: Store;
let config: Config["config"];
const saved = { ...process.env };

/** Les réglages à chaud et l'accesseur qui les lit — ce que les routes et le lecteur consultent. */
const HOT: [key: string, read: () => unknown, env: string, app: string, envRead: unknown, appRead: unknown, fallbackRead: unknown][] = [
  ["PLAYER_SERVER_FALLBACK", () => config.player.serverFallback, "false", "true", false, true, true],
  ["PLAYER_ENABLED", () => config.player.enabled, "false", "true", false, true, true],
  ["OFFLINE_DOWNLOADS", () => config.player.offlineDownloads, "false", "true", false, true, true],
  ["OFFLINE_DOWNLOADS_FOR_EVERYONE", () => config.player.offlineDownloadsForEveryone, "true", "false", true, false, false],
  ["PLAYER_AUTO_FRAME", () => config.player.autoFrame, "false", "true", false, true, true],
  ["APP_LANGUAGE", () => config.app.language, "de", "fr", "de", "fr", "en"],
  ["NEW_ACCOUNT_BLOCKED_TAGS", () => config.accounts.newBlockedTags, "a", "prive", "a", "prive", ""],
  ["OMDB_API_KEY", () => config.omdb.apiKey, "env-omdb", "app-omdb", "env-omdb", "app-omdb", ""],
  ["MDBLIST_API_KEY", () => config.mdblist.apiKey, "env-mdb", "app-mdb", "env-mdb", "app-mdb", ""],
  ["BAZARR_API_KEY", () => config.bazarr.apiKey, "env-bz", "app-bz", "env-bz", "app-bz", ""],
  ["JACKETT_API_KEY", () => config.jackett.apiKey, "env-jk", "app-jk", "env-jk", "app-jk", ""],
  ["QBITTORRENT_PASSWORD", () => config.qbittorrent.password, "env-qb", "app-qb", "env-qb", "app-qb", ""],
  ["VAPID_SUBJECT", () => config.push.subject, "mailto:env@x", "mailto:app@x", "mailto:env@x", "mailto:app@x", "mailto:admin@example.com"],
];

beforeAll(async () => {
  vi.resetModules();
  process.env.DATA_DIR = dir;
  store = await import("@/lib/settings/store");
  setup = await import("@/lib/settings/setup");
  config = (await import("@/lib/config")).config;
});
beforeEach(() => {
  for (const [key] of HOT) delete process.env[key];
  for (const k of ["COOKIE_SECURE", "TRUSTED_PROXIES", "SESSION_SECRET"]) delete process.env[k];
  for (const f of ["cine.db", "cine.db-wal", "cine.db-shm"]) fs.rmSync(path.join(dir, f), { force: true });
  store.resetSettingsStoreForTests();
});
afterAll(() => {
  process.env = saved;
});

describe("un réglage de la Configuration", () => {
  it.each(HOT)("%s : application → .env → défaut, relu à chaque accès", (key, read, env, app, envRead, appRead, fallbackRead) => {
    expect(read()).toEqual(fallbackRead);
    process.env[key] = env;
    expect(read()).toEqual(envRead);
    expect(setup.saveSettings({ [key]: app }).errors).toEqual({});
    // Sans redémarrage ni rechargement de module : la valeur suivante est déjà la nouvelle.
    expect(read()).toEqual(appRead);
    expect(setup.resetSetting(key)).toBe(true);
    expect(read()).toEqual(envRead);
  });

  it("garde le repli vers le lecteur du serveur actif par défaut", () => {
    expect(config.player.serverFallback).toBe(true);
    expect(SETTINGS.find((s) => s.key === "PLAYER_SERVER_FALLBACK")).toMatchObject({ inApp: true, group: "playback", fallback: "true" });
  });
});

describe("ce qui ne se règle jamais dans l'application", () => {
  it.each([
    ["COOKIE_SECURE", "true", () => config.app.cookieSecure, false],
    ["TRUSTED_PROXIES", "proxy", () => config.network.trustedProxies, ""],
    ["SESSION_SECRET", "forge", () => config.app.sessionSecret, "change-me-in-production"],
  ] as const)("%s : refusé par l'interface, ignoré s'il traîne en base", (key, value, read, fallback) => {
    expect(setup.saveSettings({ [key]: value }).errors).toEqual({ [key]: "unknown" });
    store.writeOverride(key, value); // une ligne d'avant le 13/10/2026
    expect(read()).toEqual(fallback);
    process.env[key] = value;
    expect(read()).not.toEqual(fallback);
  });

  // La page Déploiement dit ce qui est posé (13/10/2026) : elle lit la vue du réglage, qui doit
  // dire ce que `config.ts` applique — l'environnement seul — et non une ligne restée en base.
  it("montre la valeur de l'environnement, pas une ligne restée en base", () => {
    store.writeOverride("TRUSTED_PROXIES", "vieille-ligne");
    expect(setup.settingView("TRUSTED_PROXIES")).toMatchObject({ source: "default", value: "" });
    process.env.TRUSTED_PROXIES = "proxy-container";
    expect(setup.settingView("TRUSTED_PROXIES")).toMatchObject({ source: "env", value: "proxy-container" });
  });

  it("et le guide de déploiement explique chacun d'eux", async () => {
    const { DEPLOYMENT_GUIDE, GENERATED_SECRETS } = await import("@/lib/settings/schema");
    const guided = new Set(DEPLOYMENT_GUIDE.flatMap((e) => e.keys));
    for (const key of ["COOKIE_SECURE", "TRUSTED_PROXIES", "MEDIA_ROOT", "MOVIES_PATH", "TZ"]) expect([key, guided.has(key)]).toEqual([key, true]);
    expect([...GENERATED_SECRETS]).toEqual(["SESSION_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]);
  });
});

describe("la correspondance entre le schéma et config.ts", () => {
  const src = fs.readFileSync("src/lib/config.ts", "utf8");
  const viaOverride = new Set([...src.matchAll(/optional\("([A-Z_]+)"/g)].map((m) => m[1]));
  // Lus ailleurs, toujours par le magasin de réglages : les profils (`qualityProfile.ts`), le
  // préchauffage (`posterPrewarm.ts`, au démarrage).
  const readElsewhere = new Set(["RADARR_QUALITY_PROFILE", "SONARR_QUALITY_PROFILE", "POSTER_PREWARM"]);

  it("lit chaque réglage de l'application par le magasin (pas seulement .env)", () => {
    const missed = SETTINGS.filter((s) => s.inApp && !viaOverride.has(s.key) && !readElsewhere.has(s.key)).map((s) => s.key);
    expect(missed).toEqual([]);
  });

  it("ne laisse aucune valeur hors schéma être changée par une ligne en base", () => {
    const inApp = new Set(SETTINGS.filter((s) => s.inApp).map((s) => s.key));
    expect([...viaOverride].filter((k) => !inApp.has(k))).toEqual([]);
  });

  it("dit « au prochain démarrage » pour ce qui n'est lu qu'au démarrage, et pour lui seul", () => {
    expect(SETTINGS.filter((s) => s.restart).map((s) => s.key)).toEqual(["POSTER_PREWARM"]);
  });
});
