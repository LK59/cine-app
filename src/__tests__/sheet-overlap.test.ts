import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Le titre d'une fiche téléphone doit rester devant la bannière qu'il chevauche.
 *
 * Les deux fiches posent leur contenu 24 px sous l'image d'en-tête, pour que le titre tombe dans
 * le fondu de l'image — c'est voulu. Mais l'image est positionnée et le bloc de contenu ne
 * l'était pas : un élément positionné se peint après les blocs statiques quel que soit l'ordre du
 * document, donc le bas opaque du dégradé recouvrait le titre. Sur une fiche de bibliothèque le
 * logo est assez haut pour que ça passe inaperçu ; sur une fiche TMDB, où le titre est du texte de
 * 24 px, il n'en restait qu'un liseré et la fiche paraissait sans titre.
 *
 * Rien de tout cela ne se voit dans jsdom, qui ne peint pas : la règle est donc vérifiée sur la
 * source. Partout où un bloc remonte sous l'en-tête, il doit se positionner à son tour.
 */
const SHEETS = [
  "src/components/player/PlayerDiscoverSheet.tsx",
  "src/components/cinema/mobile/CinemaMobileDetail.tsx",
];

describe("phone sheets", () => {
  it.each(SHEETS)("keeps %s's content in front of the header it overlaps", (file) => {
    const source = readFileSync(file, "utf8");
    const overlapping = source
      .split("\n")
      .filter((line) => line.includes("-mt-6") && line.includes("className"));

    // Si le chevauchement disparaît un jour, ce test n'a plus d'objet — mais tant qu'il existe,
    // il doit être positionné.
    expect(overlapping.length).toBeGreaterThan(0);
    for (const line of overlapping) expect(line).toContain("relative");
  });
});
