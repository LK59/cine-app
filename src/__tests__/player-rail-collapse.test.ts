import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "../..", "src/app/globals.css"), "utf8");

/**
 * Le rail du bureau se replie quand la souris le quitte, quel que soit le bouton cliqué.
 *
 * Il restait déplié par `:focus-within`, que donne aussi un clic de souris : après « Accueil »,
 * qui ne déplace pas le focus, il ne se repliait qu'au clic suivant ailleurs (23/09/2026). Seul
 * le focus du clavier le garde ouvert — jsdom ne calcule pas les styles, d'où la lecture du fichier.
 */
describe("rail du bureau", () => {
  it("ne reste déplié que pour le focus du clavier", () => {
    expect(css).not.toMatch(/\.player-rail:focus-within/);
    expect(css).toMatch(/\.player-rail:has\(:focus-visible\)\s*\{[^}]*width: 11rem/);
  });
});
