import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { NAV_GROUPS, NAV_ITEMS, NAV_BAR_HREFS, NAV_PARTS, activeNavHref, CINEMA_HREF } from "@/components/navItems";
import fr from "@/locales/fr.json";

/**
 * Les deux coquilles — barre latérale et menu du téléphone — lisaient chacune leur liste, et
 * elles avaient divergé sur l'ordre comme sur le rangement. Ces épreuves tiennent la description
 * partagée : une seule source, dans un ordre décidé une fois.
 */
describe("navigation", () => {
  it("ne déclare aucune destination deux fois", () => {
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("range chaque groupe sous un intitulé qui existe dans les traductions", () => {
    for (const key of [...NAV_GROUPS.flatMap((g) => (g.titleKey ? [g.titleKey] : [])), ...NAV_PARTS.map((p) => p.titleKey)]) {
      const path = key.split(".");
      const value = path.reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], fr);
      expect(typeof value, key).toBe("string");
    }
  });

  it("nomme chaque entrée avec une clé qui existe dans les traductions", () => {
    for (const item of NAV_ITEMS) {
      const value = item.navKey.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], fr);
      expect(typeof value, item.navKey).toBe("string");
    }
  });

  it("épingle sur la barre du bas quatre destinations qui existent bien dans les groupes", () => {
    expect(NAV_BAR_HREFS).toHaveLength(4);
    for (const href of NAV_BAR_HREFS) {
      expect(NAV_ITEMS.some((i) => i.href === href), href).toBe(true);
    }
  });

  // DECISIONS.md §81 : deux parties, dans cet ordre — ce qui tourne, puis comment c'est réglé.
  it("tient en deux parties, Infrastructure puis Configuration", () => {
    expect(NAV_PARTS.map((p) => p.key)).toEqual(["infrastructure", "configuration"]);
    const infra = NAV_PARTS[0].groups.flatMap((g) => g.items.map((i) => i.href));
    expect(infra.slice(0, 7)).toEqual(["/gestion", "/radarr", "/sonarr", "/qbittorrent", "/calendar", "/stats", "/timeline"]);
    const conf = NAV_PARTS[1].groups.flatMap((g) => g.items.map((i) => i.href));
    expect(conf.every((h) => h.startsWith("/parametres"))).toBe(true);
    // Les connexions d'abord ; ce qui exige de toucher au compose, en dernier.
    expect(conf[0]).toBe("/parametres");
    expect(conf[conf.length - 1]).toBe("/parametres/deploiement");
    expect(NAV_ITEMS[NAV_ITEMS.length - 1].href).toBe("/parametres/deploiement");
  });

  it("donne une page à chaque entrée de la Configuration", () => {
    for (const { href } of NAV_PARTS[1].groups.flatMap((g) => g.items)) {
      expect([href, existsSync(`src/app/(dashboard)${href}/page.tsx`)]).toEqual([href, true]);
    }
  });

  it("n'allume qu'une entrée : la plus précise", () => {
    expect(activeNavHref("/parametres")).toBe("/parametres");
    expect(activeNavHref("/parametres/lecture")).toBe("/parametres/lecture");
    expect(activeNavHref("/radarr/12")).toBe("/radarr");
    expect(activeNavHref("/ailleurs")).toBeNull();
  });

  it("appelle « Imports » l'ancienne « Activité récente », dans les quatre langues", () => {
    // « Activité » est le panneau de l'administrateur au cinéma ; deux pages du même nom, deux sujets.
    for (const lang of ["fr", "en", "es", "de"]) {
      const dict = JSON.parse(readFileSync(`src/locales/${lang}.json`, "utf8"));
      expect([lang, dict.nav.timeline]).toEqual([lang, dict.timeline.pageTitle]);
      expect(dict.nav.timeline).not.toMatch(/activ/i);
    }
    expect(NAV_ITEMS.find((i) => i.href === "/timeline")?.navKey).toBe("nav.timeline");
  });

  it("ne garde ni la langue, ni les sessions, ni la couleur d'accent dans la gestion", () => {
    const pages = ["", "/lecture", "/sous-titres", "/comptes", "/administration", "/deploiement"].map((p) => `src/app/(dashboard)/parametres${p}/page.tsx`);
    const src = [...pages, "src/components/settings/AdminTools.tsx"].map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/LanguageSection|SessionsCard|useTheme|ACCENT_PRESETS|\/api\/auth\/sessions|setLocale/);
  });

  it("ouvre la navigation sur le pont vers le cinéma, et garde le lien vers le Compte", () => {
    expect(CINEMA_HREF).toBe("/");
    for (const f of ["src/components/Sidebar.tsx", "src/components/MobileNav.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect([f, src.includes("<BackToCinema")]).toEqual([f, true]);
      expect([f, src.includes("<AccountPreferencesLink")]).toEqual([f, true]);
    }
    const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
    // Le pont avant toute entrée de la liste.
    expect(sidebar.indexOf("<BackToCinema")).toBeLessThan(sidebar.indexOf("NAV_PARTS.map"));
    expect(sidebar).not.toContain("Cine App");
  });

  it("ne donne pas le même intitulé à deux pages différentes", () => {
    const labels = NAV_ITEMS.map((i) =>
      i.navKey.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], fr)
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("la couleur d'accent n'est plus un réglage", () => {
  // Retirée le 13/10/2026 (DECISIONS.md §81) : le violet du cinéma, fixe. Une préférence restée dans
  // le stockage d'un appareil (`cine-accent`) n'est plus lue par rien.
  it("ni fournisseur de thème, ni préréglages, ni script avant la première image", () => {
    expect(existsSync("src/components/ThemeProvider.tsx")).toBe(false);
    expect(existsSync("src/lib/theme.ts")).toBe(false);
    expect(readFileSync("src/app/layout.tsx", "utf8")).not.toMatch(/cine-accent|dataset\.accent|ThemeProvider/);
  });

  it("une seule valeur de l'accent dans la feuille de style", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).not.toMatch(/\[data-accent/);
    expect([...css.matchAll(/--accent-500:/g)]).toHaveLength(1);
  });
});
