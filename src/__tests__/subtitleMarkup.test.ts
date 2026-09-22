import { describe, it, expect } from "vitest";
import { stripSubtitleMarkup, subtitlePlacement } from "@/lib/webcodecs/subtitleMarkup";

/**
 * 22/09/2026 : un sous-titre forcé de *Ted Lasso*, piste SubRip, s'affichait « {\an8}Madeleine
 * L'Engle » — une balise de position ASS glissée dans du SubRip, montrée telle quelle.
 */
describe("stripSubtitleMarkup et subtitlePlacement", () => {
  it("retire la balise de position mais retient qu'il faut afficher en haut", () => {
    const cleaned = stripSubtitleMarkup("{\\an8}Madeleine L'Engle");
    expect(subtitlePlacement(cleaned)).toEqual({ text: "Madeleine L'Engle", top: true });
  });

  it("retire les autres blocs d'override et laisse en bas ce qui n'a pas de position", () => {
    expect(subtitlePlacement(stripSubtitleMarkup("{\\i1}Bonjour{\\i0} à tous"))).toEqual({ text: "Bonjour à tous", top: false });
    // \an2, c'est le bas centré : la place ordinaire, rien à retenir.
    expect(stripSubtitleMarkup("{\\an2}En bas")).toBe("En bas");
  });

  it("garde une accolade de texte dans du SubRip", () => {
    expect(stripSubtitleMarkup("Il a écrit {sic}")).toBe("Il a écrit {sic}");
  });

  it("retire toute accolade dans de l'ASS, commentaires compris", () => {
    expect(stripSubtitleMarkup("{un commentaire}{\\an8}Là-haut", { allBraces: true })).toBe("{\\an8}Là-haut");
  });

  it("continue de retirer les chevrons", () => {
    expect(stripSubtitleMarkup("<i>italique</i>")).toBe("italique");
  });
});
