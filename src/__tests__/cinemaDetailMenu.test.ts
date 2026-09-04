import { describe, it, expect } from "vitest";
import {
  MENU_ROW,
  MENU_ROW_INACTIVE,
  MENU_ROW_PRIMARY,
  MENU_BADGE,
  MENU_BADGE_ACTIVE,
} from "@/components/cinema/detailMenu";

/** Les utilitaires de couleur de texte déclarés par une chaîne de classes. */
const textColours = (classes: string) =>
  classes.split(/\s+/).filter((c) => /^text-(?!left$|sm$|xs$|base$|lg$)/.test(c));

describe("le menu d'une fiche en mode cinéma", () => {
  /**
   * La ligne principale s'était affichée blanche sur blanc, donc entièrement vide.
   *
   * `text-white` était déclaré par la forme commune, et la ligne blanche tentait de le corriger
   * avec `text-ink`. Deux utilitaires de même spécificité : c'est leur ordre dans la feuille
   * compilée qui tranche, pas leur ordre dans l'attribut — et Tailwind y écrit `.text-white`
   * après `.text-ink`. Une couleur ne se corrige donc pas, elle se déclare une seule fois.
   */
  it("ne déclare aucune couleur de texte dans la forme commune", () => {
    expect(textColours(MENU_ROW)).toEqual([]);
  });

  it("laisse chaque variante déclarer la sienne, une seule fois", () => {
    expect(textColours(MENU_ROW_INACTIVE)).toEqual(["text-white"]);
    expect(textColours(MENU_ROW_PRIMARY)).toEqual(["text-ink"]);
  });

  it("compose la ligne principale à partir de la forme commune", () => {
    expect(MENU_ROW_PRIMARY.startsWith(MENU_ROW)).toBe(true);
    expect(MENU_ROW_PRIMARY).toContain("bg-white");
  });

  /** L'accent ne marque plus « où l'on est » : il ne dit plus qu'un état déjà acquis. */
  it("garde l'accent pour l'état, et le blanc pour le repère de position", () => {
    expect(MENU_ROW_INACTIVE).not.toContain("accent");
    expect(MENU_BADGE_ACTIVE).toContain("accent");
    expect(MENU_BADGE).not.toContain("accent");
  });

  /** Un repère de position qui crie autant qu'une sélection se lit comme une sélection. */
  it("garde le repère de position discret", () => {
    expect(MENU_ROW_INACTIVE).toContain("focus-visible:bg-white/14");
    expect(MENU_ROW_INACTIVE).toContain("focus-visible:ring-white/20");
    expect(MENU_ROW_INACTIVE).not.toContain("ring-2");
  });
});
