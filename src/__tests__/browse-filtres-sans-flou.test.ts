import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// La rangée des réglages de « Tous les films » : aucun flou d'arrière-plan (13/10/2026). Cinq
// `backdrop-filter` sur le fond uni du panneau marquaient un à-coup sur iPhone quand la rangée
// reparaissait en remontant la grille.
describe("CinemaBrowseSheet — réglages sans backdrop-filter", () => {
  const source = readFileSync("src/components/cinema/CinemaBrowseSheet.tsx", "utf8");
  it("n'emploie ni `input` ni `select` (qui portent backdrop-blur-xs) ni aucun flou", () => {
    expect(source).not.toMatch(/className="(input|select)\b/);
    expect(source).not.toMatch(/className=[^\n]*backdrop-blur/);
    expect(source).toMatch(/className=\{FILTER_SELECT\}/);
  });
});

// Le logo de l'application garde ses couleurs (§83) : les claps du rail, de la barre du téléphone et
// de la barre latérale de la gestion étaient passés au blanc avec l'accent. Depuis le 23/10/2026, le
// logo y est le glyphe Laterna (`BrandMark`), qui porte ses couleurs lui-même.
describe("logo de l'application — en couleurs", () => {
  it.each(["src/components/cinema/mobile/CinemaMobileClient.tsx", "src/components/player/PlayerRail.tsx", "src/components/Sidebar.tsx"])("%s", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/<BrandMark\b/);
    expect(source).not.toMatch(/<Clapperboard\b/);
  });
});

// Le champ « Filtrer » garde sa largeur de 10 rem : recopié avec `w-full` (13/10/2026), il prenait
// toute la ligne et cachait les menus voisins, films comme séries.
describe("CinemaBrowseSheet — champ Filtrer", () => {
  it("n'a pas de largeur pleine", () => {
    const source = readFileSync("src/components/cinema/CinemaBrowseSheet.tsx", "utf8");
    expect(source).not.toMatch(/const FILTER_(BASE|FIELD)[^\n]*w-full/);
    expect(source).toMatch(/\$\{FILTER_FIELD\} w-40/);
  });
});
