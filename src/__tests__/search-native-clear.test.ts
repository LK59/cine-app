import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// La Recherche du cinéma dessine sa propre croix (`PlayerSearchPanel`) et masque celle du navigateur
// (`search-no-native-clear`). `appearance: none` ne la masque que dans Chromium : WebKit — Safari sur
// Mac — gardait sa croix ronde à côté de la nôtre (chasse de nuit du 18/11/2026, mesuré sous
// Playwright : seule `display: none` la retire dans les deux moteurs).
const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

describe("la croix native d'un champ de recherche", () => {
  it("est retirée par display: none, pas seulement par appearance", () => {
    const start = css.indexOf("@utility search-no-native-clear {");
    expect(start).toBeGreaterThanOrEqual(0);
    const rule = css.slice(start, css.indexOf("\n}\n", start));
    expect(rule).toContain("::-webkit-search-cancel-button");
    expect(rule).toMatch(/display:\s*none;/);
  });
});
