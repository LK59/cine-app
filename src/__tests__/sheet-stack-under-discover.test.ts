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

/**
 * Une fiche ne peut pas être derrière elle-même.
 *
 * Ouvrir une fiche TMDB garde le `film` de l'adresse : sans cette garde, « ce qu'on laisse
 * derrière » désigne la fiche affichée, la pile porte deux fois la même clé, et React en remonte
 * une — la fiche du dessous se retrouvait en haut de page, puis se recalait au retour.
 */
describe("la fiche du dessous n'est jamais celle du dessus", () => {
  it("le téléphone écarte l'entrée qui désigne la fiche courante", () => {
    const src = readFileSync("src/components/cinema/mobile/CinemaMobileClient.tsx", "utf8");
    expect(src).toMatch(/if \(id === \(isSeries \? route\.serie : route\.film\)\) return null;/);
  });

  it("le bureau garde la sienne", () => {
    const src = readFileSync("src/components/cinema/CinemaClient.tsx", "utf8");
    expect(src).toMatch(/behind\.film !== route\.film/);
    expect(src).toMatch(/behind\.serie !== route\.serie/);
  });
});

/** Les deux sortes de fiche entrent et sortent de la même façon sur téléphone. */
describe("les fiches TMDB s'animent comme les fiches de bibliothèque", () => {
  it.each([
    "src/components/player/PlayerDiscoverSheet.tsx",
    "src/components/player/PlayerPersonSheet.tsx",
  ])("%s utilise sheet-in / sheet-out", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/"sheet-in/);
    expect(src).toMatch(/"sheet-out/);
    // Les anciennes classes, qui ne ressemblaient à aucune fiche de bibliothèque.
    expect(src).not.toMatch(/"animate-slide-up/);
    expect(src).not.toMatch(/"animate-fade-out-down/);
  });

  it("leur sursis de sortie vaut la durée de sheet-out sur téléphone", () => {
    const src = readFileSync("src/components/player/PlayerShell.tsx", "utf8");
    expect(src).toMatch(/isMobile \? SHEET_OUT_MS : EXIT_MS/);
  });
});
