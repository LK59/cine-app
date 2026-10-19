import { describe, it, expect } from "vitest";
import { applyResumeRules } from "@/lib/offline/resumeRules";

/**
 * La règle de reprise de Jellyfin appliquée à une lecture hors ligne (Louis, 19/10/2026) : les seuils
 * de ce serveur-ci (2 % et 95 %), et la durée minimale en dessous de laquelle rien n'est gardé.
 */
const rules = { min: 2, max: 95, minDurationSeconds: 300 };

describe("applyResumeRules", () => {
  it("garde la position à la seconde entre les deux seuils", () => {
    expect(applyResumeRules(1234.5, 6000, rules)).toEqual({ seconds: 1234.5, watched: false });
  });
  it("sous le minimum : pas de reprise", () => {
    expect(applyResumeRules(100, 6000, rules)).toEqual({ seconds: 0, watched: false });
  });
  it("au-delà du maximum : vu, et la position repart à zéro", () => {
    expect(applyResumeRules(5800, 6000, rules)).toEqual({ seconds: 0, watched: true });
  });
  it("un titre plus court que la durée minimale ne garde jamais de position", () => {
    expect(applyResumeRules(120, 240, rules)).toEqual({ seconds: 0, watched: false });
  });
});
