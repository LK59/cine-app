import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * La pile des fiches reste dessinée sous une fiche TMDB.
 *
 * Ce que ça évite, et qui n'était visible que sur un vrai appareil : une rangée de saga ouvre une
 * fiche découverte pour tout titre absent de la bibliothèque — près d'un tiers d'entre eux. Tant
 * que la pile n'était pas rendue dans ce cas, le film d'où l'on venait était démonté : on voyait
 * la grille derrière l'animation de fermeture, puis il revenait d'un coup, en haut de page.
 *
 * Le test lit la source parce que la faute était une *condition de rendu*, et qu'aucune assertion
 * sur le DOM d'un composant monté seul ne l'aurait montrée : il aurait fallu la pile, l'adresse,
 * l'historique et deux fiches. La règle, elle, tient en une ligne — et c'est cette ligne qui avait
 * été écrite trois fois de suite sans qu'on la voie.
 */
const FILES = [
  "src/components/cinema/mobile/CinemaMobileClient.tsx",
  "src/components/cinema/CinemaClient.tsx",
];

describe("la pile des fiches sous une fiche découverte", () => {
  it.each(FILES)("%s ne conditionne pas le rendu de la pile à l'absence de fiche TMDB", (file) => {
    const src = readFileSync(file, "utf8");
    // Les deux formes exactes qui portaient la faute.
    expect(src).not.toMatch(/route\.discover === null &&\s*\n\s*route\.person === null &&\s*\n\s*stack\.map/);
    expect(src).not.toMatch(/\{!sheetAbove &&\s*\n\s*\w+Stack\.map/);
  });

  it.each(FILES)("%s rend la fiche du dessus inerte quand une fiche TMDB la recouvre", (file) => {
    const src = readFileSync(file, "utf8");
    // `top` doit tomber à faux dès qu'une fiche TMDB est ouverte, sinon la fiche du dessous
    // garderait ses gestes et son plan sous une fiche qui, elle, est au-dessus d'elle.
    expect(src).toMatch(/const top = !(covered|sheetAbove) && i === \w+\.length - 1;/);
  });
});
