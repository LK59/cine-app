import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "fs";

vi.mock("@/lib/session", () => ({ verifySessionFull: vi.fn(async () => null) }));

import { CONFIG_LAYOUT, CUSTOM_CARD_GROUPS, NEED_HREF, missingNeeds, type ConfigCard, type ConfigNeed } from "@/lib/settings/configLayout";
import { SETTINGS, SETTINGS_BY_KEY, type SettingView } from "@/lib/settings/schema";
import { AI_FEATURES } from "@/lib/aiFeatureTable";
import { NAV_ITEMS } from "@/components/navItems";
import { isAdminOnlyPage } from "@/proxy";

/**
 * La disposition de la Configuration (DECISIONS.md §142) : une place par fonction, et des cartes
 * de fonction qui disent ce dont elles ont besoin. La page « Sous-titres » tenait toutes les
 * fonctions d'IA ; « Lecture », le lecteur, le hors-ligne, les livres, le Chromecast et le
 * recadrage ; l'interrupteur des acteurs à l'écran était dans Connexions, leur analyse ailleurs.
 */
const ALL_CARDS: ConfigCard[] = Object.values(CONFIG_LAYOUT).flat();

const keysOf = (card: ConfigCard) => card.keys ?? SETTINGS.filter((s) => s.group === card.group && s.inApp).map((s) => s.key);

function lookup(dict: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], dict);
}

const LANGS = ["fr", "en", "es", "de"] as const;
const dicts = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readFileSync(`src/locales/${l}.json`, "utf8"))]));

describe("une place par réglage", () => {
  it("montre chaque réglage réglable dans l'application une fois et une seule", () => {
    const shown = ALL_CARDS.flatMap(keysOf);
    const custom = SETTINGS.filter((s) => s.inApp && CUSTOM_CARD_GROUPS.includes(s.group)).map((s) => s.key);
    const everything = [...shown, ...custom].sort();
    const dupes = everything.filter((k, i) => everything[i - 1] === k);
    expect(dupes).toEqual([]);
    const missing = SETTINGS.filter((s) => s.inApp && !everything.includes(s.key)).map((s) => s.key);
    expect(missing).toEqual([]);
  });

  it("chaque clé d'une carte appartient au groupe de la carte (l'enregistrement par carte filtre ainsi)", () => {
    for (const card of ALL_CARDS) {
      for (const key of keysOf(card)) expect([key, SETTINGS_BY_KEY.get(key)?.group]).toEqual([key, card.group]);
    }
  });

  it("Connexions : les services seulement — du service X-Ray, l'adresse et la clé", () => {
    const keys = CONFIG_LAYOUT.connections.flatMap(keysOf);
    expect(keys).toContain("XRAY_URL");
    expect(keys).toContain("XRAY_API_KEY");
    expect(keys).not.toContain("XRAY_ENABLED");
    expect(CONFIG_LAYOUT.xray.flatMap(keysOf)).toEqual(["XRAY_ENABLED", "SCENE_RESTART_ENABLED"]);
  });

  it("Lecture : le lecteur seulement ; le reste a sa page", () => {
    expect(CONFIG_LAYOUT.playback.flatMap(keysOf)).toEqual(["PLAYER_ENABLED", "PLAYER_SERVER_FALLBACK"]);
    expect(CONFIG_LAYOUT.diffusion.flatMap(keysOf).sort()).toEqual(
      ["CAST_RECEIVER_APP_ID", "CHROMECAST_FOR_EVERYONE", "OFFLINE_DOWNLOADS", "OFFLINE_DOWNLOADS_FOR_EVERYONE", "OFFLINE_SERVER_QUOTA_GB"].sort(),
    );
    expect(CONFIG_LAYOUT.books.flatMap(keysOf).sort()).toEqual(["BOOKS_ENABLED", "BOOKS_GOOGLE_ENRICH", "BOOKS_REQUESTS_ENABLED", "GOOGLE_BOOKS_API_KEY"]);
    expect(CONFIG_LAYOUT.autoFrame.flatMap(keysOf)).toEqual(["PLAYER_AUTO_FRAME"]);
  });

  it("Intelligence artificielle : le fournisseur commun, puis une carte par fonction payante, avec son état", () => {
    expect(CONFIG_LAYOUT.aiProvider.flatMap(keysOf)).toEqual([
      "SUBTITLE_GEN_PROVIDER",
      "SUBTITLE_GEN_API_KEY",
      "SUBTITLE_GEN_MODEL",
      "SUBTITLE_GEN_BUDGET_USD",
      "SUBTITLE_GEN_PRICE_INPUT",
      "SUBTITLE_GEN_PRICE_OUTPUT",
    ]);
    // Chaque fonction de la table (§140) a sa carte, qui montre son état, sur la page IA ou celle des acteurs.
    for (const f of AI_FEATURES) {
      const card = ([...CONFIG_LAYOUT.aiFeatures, ...CONFIG_LAYOUT.xray] as ConfigCard[]).find((c) => c.feature === f.id);
      expect([f.id, card?.keys]).toEqual([f.id, [f.setting]]);
    }
  });

  it("les besoins des cartes suivent ceux de la table des fonctions", () => {
    // Les cartes de fonction seulement : « Revenir au début de la scène » (§143) n'est pas une fonction de la table.
    for (const card of ([...CONFIG_LAYOUT.aiFeatures, ...CONFIG_LAYOUT.xray] as ConfigCard[]).filter((c) => c.feature)) {
      const row = AI_FEATURES.find((f) => f.id === card.feature)!;
      const needs = card.needs ?? [];
      expect([row.id, row.needs.includes("provider")]).toEqual([row.id, needs.includes("aiKey")]);
      expect([row.id, row.needs.includes("xray")]).toEqual([row.id, needs.includes("xrayOn") && needs.includes("xrayService")]);
      expect([row.id, row.needs.includes("xrayService")]).toEqual([row.id, needs.includes("xrayService") && !needs.includes("xrayOn")]);
    }
  });
});

describe("les textes des cartes", () => {
  it("chaque intitulé, explication et besoin existe dans les quatre langues", () => {
    const keys = new Set<string>();
    for (const card of ALL_CARDS) {
      if (card.titleKey) keys.add(card.titleKey);
      if (card.whyKey) keys.add(card.whyKey);
    }
    for (const need of Object.keys(NEED_HREF)) {
      keys.add(`config.needs.${need}`);
      keys.add(`config.needs.fix.${need}`);
    }
    keys.add("config.needs.missing");
    keys.add("config.needs.ready");
    for (const key of ["nav.config.ai", "nav.config.diffusion", "nav.config.books", "nav.config.autoFrame", "nav.sections.smart", "config.ai.hint", "config.diffusion.hint", "config.books.hint", "config.autoFrame.hint", "config.ai.featuresTitle", "config.ai.featuresIntro"]) keys.add(key);
    for (const lang of LANGS) for (const key of keys) expect([lang, key, typeof lookup(dicts[lang], key)]).toEqual([lang, key, "string"]);
  });

  it("plus aucun texte ne renvoie aux Connexions pour allumer les acteurs à l'écran", () => {
    for (const lang of LANGS) {
      for (const key of ["xrayScan.off", "subSync.off"]) {
        const value = String(lookup(dicts[lang], key));
        const smart = String(lookup(dicts[lang], "nav.sections.smart"));
        // L'un dit « ci-dessus » (la carte de la même page), l'autre nomme la partie où elle se trouve.
        expect([lang, key, key === "subSync.off" ? value.includes(smart) : true]).toEqual([lang, key, true]);
      }
    }
  });
});

describe("ce qui manque", () => {
  const view = (key: string, o: Partial<SettingView> = {}): SettingView => ({ key, source: "default", value: "", set: false, hint: null, envPresent: false, ...o });
  const views = (...v: SettingView[]) => new Map(v.map((x) => [x.key, x]));

  it("se lit sur les réglages enregistrés, avec les mêmes règles que le serveur", () => {
    const all: ConfigNeed[] = ["aiKey", "xrayService", "xrayOn", "booksOn", "playerOn"];
    const empty = views(view("SUBTITLE_GEN_API_KEY"), view("XRAY_URL", { value: "http://laterna-xray:8000" }), view("XRAY_API_KEY"), view("XRAY_ENABLED", { value: "off" }), view("BOOKS_ENABLED", { value: "false" }), view("PLAYER_ENABLED", { value: "true" }));
    expect(missingNeeds(all, empty)).toEqual(["aiKey", "xrayService", "xrayOn", "booksOn"]);
    const ready = views(
      view("SUBTITLE_GEN_API_KEY", { set: true, value: null }),
      view("XRAY_URL", { value: "http://laterna-xray:8000" }),
      view("XRAY_API_KEY", { set: true, value: null }),
      // Une valeur d'avant les publics (`true`) vaut « tous » (featureAudience).
      view("XRAY_ENABLED", { value: "true" }),
      view("BOOKS_ENABLED", { value: "true" }),
      view("PLAYER_ENABLED", { value: "true" }),
    );
    expect(missingNeeds(all, ready)).toEqual([]);
    expect(missingNeeds(["playerOn"], views(view("PLAYER_ENABLED", { value: "false" })))).toEqual(["playerOn"]);
  });

  it("ne dit rien tant que les réglages ne sont pas arrivés", () => {
    expect(missingNeeds(["aiKey"], new Map())).toEqual([]);
  });

  it("mène vers une page de la Configuration qui existe", () => {
    for (const href of Object.values(NEED_HREF)) {
      const path = href.split("#")[0];
      expect([href, NAV_ITEMS.some((i) => i.href === path)]).toEqual([href, true]);
    }
  });
});

describe("les adresses", () => {
  it("chaque page de la Configuration reste à l'administrateur", () => {
    for (const href of ["/parametres/ia", "/parametres/diffusion", "/parametres/livres", "/parametres/recadrage", "/parametres/sous-titres"]) {
      expect([href, isAdminOnlyPage(href)]).toEqual([href, true]);
    }
  });

  it("l'ancienne page des sous-titres générés renvoie, en 308, vers l'intelligence artificielle", () => {
    const src = readFileSync("src/app/(dashboard)/parametres/sous-titres/page.tsx", "utf8");
    expect(src).toMatch(/permanentRedirect\("\/parametres\/ia"\)/);
    expect(existsSync("src/app/(dashboard)/parametres/ia/page.tsx")).toBe(true);
  });

  it("les pages lisent leurs cartes dans la disposition commune, sans liste à elles", () => {
    for (const { href } of NAV_ITEMS.filter((i) => i.href.startsWith("/parametres"))) {
      const src = readFileSync(`src/app/(dashboard)${href}/page.tsx`, "utf8");
      expect([href, /\bgroup:\s*"/.test(src)]).toEqual([href, false]);
    }
  });
});
