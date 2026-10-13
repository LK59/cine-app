import { describe, it, expect, vi, afterEach } from "vitest";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";
import { SETTINGS, urlProblem } from "@/lib/settings/schema";
import { testService } from "@/lib/settings/testService";
import { groupsToTest } from "@/lib/settings/wizardTests";
import { parseDfLine } from "@/lib/disk-stats";
import { cacheReadRate } from "@/components/settings/SubtitleGenCard";
import type { SettingView } from "@/lib/settings/schema";

/**
 * Les accrocs relevés en essayant l'assistant sur une installation neuve, sans `.env` (13/10/2026).
 */
afterEach(() => vi.unstubAllGlobals());

describe("une adresse sans http://", () => {
  it("est « adresse invalide » au test comme à l'enregistrement, sans rien appeler", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const values: Record<string, string> = { RADARR_URL: "radarr:7878", RADARR_API_KEY: "k" };
    expect(await testService("radarr", (k) => values[k] ?? "")).toEqual({ ok: false, detail: "invalid-url" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(urlProblem("radarr:7878")).toBe("invalid-url");
    expect(urlProblem("http://radarr:7878")).toBeNull();
  });
});

describe("les services testés à « Suivant »", () => {
  const v = (key: string, o: Partial<SettingView> = {}): SettingView => ({ key, source: "default", value: "", set: false, hint: null, envPresent: false, ...o });
  it("teste toujours les obligatoires, et un complément seulement s'il est renseigné", () => {
    expect(groupsToTest(["jellyfin", "playback"], [])).toEqual(["jellyfin"]);
    expect(groupsToTest(["jellyseerr", "qbittorrent", "bazarr"], [v("JELLYSEERR_URL", { value: "http://jellyseerr:5055" })])).toEqual([]);
    expect(
      groupsToTest(["jellyseerr", "qbittorrent", "bazarr"], [v("QBITTORRENT_URL", { source: "app", value: "http://qb:8080" }), v("BAZARR_API_KEY", { source: "app", set: true })]),
    ).toEqual(["qbittorrent", "bazarr"]);
  });
});

describe("la carte Stockage sans dossier de médias", () => {
  // Sur un chemin absent, `df` n'écrit que son en-tête : « 1-blocks » se lisait 1 octet.
  it("ne lit pas l'en-tête de df comme une taille", () => {
    expect(parseDfLine("Filesystem           1-blocks       Used Available Capacity Mounted on")).toEqual({ total: -1, used: -1, free: -1 });
    expect(parseDfLine("")).toEqual({ total: -1, used: -1, free: -1 });
    expect(parseDfLine("overlay 1000 400 600 40% /")).toEqual({ total: 1000, used: 400, free: 600 });
  });
});

describe("les sous-titres générés sans requête", () => {
  it("n'affiche pas de pourcentage (« NaN % ») tant qu'il n'y a pas de requête", () => {
    expect(cacheReadRate({ inputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, requests: 0 })).toBeNull();
    expect(cacheReadRate({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, requests: null })).toBeNull();
    expect(cacheReadRate({ inputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 50, requests: 2 })).toBe(50);
  });
});

describe("la carte « Application » de la Configuration", () => {
  // Elle ne tient plus que la préparation des affiches et le contact des notifications : son texte
  // parlait encore de langue par défaut et de connexion sécurisée, partis ailleurs (§81).
  it("ne décrit que ce qu'elle contient", () => {
    expect(SETTINGS.filter((s) => s.group === "app" && s.inApp).map((s) => s.key)).toEqual(["POSTER_PREWARM", "VAPID_SUBJECT"]);
    const words: Record<string, RegExp> = { fr: /langue|connexion/i, en: /language|secure/i, es: /idioma|conexión/i, de: /sprache|verbindung/i };
    for (const [lang, dict] of Object.entries({ fr, en, es, de })) {
      expect((dict as { setup: { groups: { app: { why: string } } } }).setup.groups.app.why, lang).not.toMatch(words[lang]);
    }
  });
});
