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

// Le logo de l'application garde son violet (§83) : les claps du rail, de la barre du téléphone et
// de la barre latérale de la gestion étaient passés au blanc avec l'accent.
describe("logo de l'application — violet de marque", () => {
  it.each(["src/components/cinema/mobile/CinemaMobileClient.tsx", "src/components/player/PlayerRail.tsx", "src/components/Sidebar.tsx"])("%s", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/<Clapperboard[^>]*text-brand/);
  });
});
