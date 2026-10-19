import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Pas de pastille sur la barre de progression (19/10/2026, Louis — DECISIONS.md §108) : comme l'app TV
 * d'Apple, rien de dessiné sur la tête de lecture, au doigt, à la souris ni au clavier. Le pouce natif
 * reste (la souris l'attrape), transparent et invisible dans tous les états.
 */
// Sans les commentaires, qui parlent de ces états sans en être.
const css = readFileSync("src/app/globals.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const thumbRules = [...css.matchAll(/([^{}]*(?:-webkit-slider-thumb|-moz-range-thumb)[^{}]*)\{([^}]*)\}/g)].filter(([, sel]) => sel.includes(".player-seek"));

describe("la barre de progression n'a pas de pastille", () => {
  it("un pouce transparent et invisible, pour WebKit et Gecko", () => {
    expect(thumbRules.length).toBeGreaterThanOrEqual(2);
    for (const [, , body] of thumbRules) {
      expect(body).toMatch(/opacity:\s*0\s*;/);
      expect(body).not.toMatch(/opacity:\s*1/);
      expect(body).not.toMatch(/currentColor/);
    }
  });

  it("aucun état ne le rallume — ni [data-scrub], ni :focus-visible", () => {
    for (const [sel] of thumbRules) expect(sel).not.toMatch(/data-scrub|focus-visible/);
  });
});
