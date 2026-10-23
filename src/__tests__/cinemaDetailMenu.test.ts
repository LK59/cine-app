import { describe, it, expect } from "vitest";
import { MENU_ROW, MENU_ROW_INACTIVE, MENU_BADGE, MENU_BADGE_ACTIVE } from "@/components/cinema/detailMenu";

/** Les utilitaires de couleur de texte déclarés par une chaîne de classes, état par état. */
const textColours = (classes: string) =>
  classes.split(/\s+/).filter((c) => /(^|:)text-(?!left$|sm$|xs$|base$|lg$)/.test(c));

describe("le menu d'une fiche en mode cinéma", () => {
  /**
   * La ligne principale s'était affichée blanche sur blanc, donc entièrement vide.
   *
   * `text-white` était déclaré par la forme commune, et la ligne blanche tentait de le corriger
   * avec `text-ink`. Deux utilitaires de même spécificité : c'est leur ordre dans la feuille
   * compilée qui tranche, pas leur ordre dans l'attribut. Une couleur ne se corrige donc pas
   * depuis la forme commune — elle s'y absente.
   */
  it("ne déclare aucune couleur de texte dans la forme commune", () => {
    expect(textColours(MENU_ROW)).toEqual([]);
  });

  /**
   * Le renversement du sélecteur passe par une pseudo-classe, dont la spécificité l'emporte de
   * façon prévisible — contrairement à deux utilitaires nus.
   */
  it("renverse la couleur du texte par l'état, jamais par la position", () => {
    expect(textColours(MENU_ROW_INACTIVE)).toEqual(["text-white", "focus-visible:text-ink"]);
  });

  /** Un seul repère : le blanc appartient au focus, aucune ligne n'est blanche au repos. */
  it("réserve le fond blanc au sélecteur", () => {
    expect(MENU_ROW_INACTIVE).toContain("focus-visible:bg-white");
    expect(MENU_ROW_INACTIVE.split(/\s+/)).not.toContain("bg-white");
    expect(MENU_ROW.split(/\s+/)).not.toContain("bg-white");
  });

  /**
   * Le fond ne marque plus « où l'on est » : il ne dit qu'un état déjà acquis — vu, dans ma
   * liste —, et un état personnel est à l'or de la marque (DECISIONS.md §83, option B) : un
   * fond or plein `brand`, une icône noire à elle et un liseré `brand-strong`, lisibles au repos
   * comme sous le sélecteur blanc. Le blanc reste au repère de position.
   */
  it("garde l'or de la marque pour l'état, et le blanc pour le repère de position", () => {
    expect(MENU_ROW_INACTIVE).not.toContain("accent");
    expect(MENU_BADGE_ACTIVE.split(/\s+/)).toContain("bg-ink");
    expect(MENU_BADGE_ACTIVE.split(/\s+/)).toContain("ring-brand/60");
    expect(MENU_BADGE_ACTIVE).not.toContain("accent");
    expect(MENU_BADGE).not.toContain("accent");
    expect(MENU_BADGE).not.toContain("brand");
  });

  /**
   * Les pastilles doivent rester lisibles sous le sélecteur blanc : la neutre se teinte du
   * texte de sa ligne ; l'active, or, porte son propre noir (11,8:1) — fixe, qu'elle soit sur la
   * ligne sombre ou sous le sélecteur blanc ; un blanc sur l'or tomberait à 1,7:1 (23/10/2026).
   */
  it("laisse la pastille neutre suivre sa ligne, et donne son noir à l'active", () => {
    expect(MENU_BADGE).toContain("bg-current/15");
    expect(textColours(MENU_BADGE_ACTIVE)).toEqual(["text-brand"]);
  });

  it("permet aux enfants d'une ligne de réagir à son focus", () => {
    expect(MENU_ROW.split(/\s+/)).toContain("group");
  });
});
