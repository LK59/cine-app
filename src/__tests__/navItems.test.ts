import { describe, it, expect } from "vitest";
import { NAV_GROUPS, NAV_ITEMS, NAV_BAR_HREFS } from "@/components/navItems";
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
    for (const group of NAV_GROUPS) {
      const path = group.titleKey.split(".");
      const value = path.reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], fr);
      expect(typeof value, group.titleKey).toBe("string");
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

  it("laisse les réglages en dernier, et non au milieu de la liste", () => {
    expect(NAV_ITEMS[NAV_ITEMS.length - 1].href).toBe("/parametres");
  });

  it("ne donne pas le même intitulé à deux pages différentes", () => {
    const labels = NAV_ITEMS.map((i) =>
      i.navKey.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], fr)
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});
