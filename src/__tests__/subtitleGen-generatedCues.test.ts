import { describe, it, expect } from "vitest";
import { GeneratedCues } from "@/lib/subtitleGen/generatedCues";

/** Les lignes d'une génération en cours : insérées triées, remplacées par rang, cherchées comme les externes. */
describe("GeneratedCues", () => {
  it("insère hors d'ordre et cherche par instant, chevauchements compris", () => {
    const cues = new GeneratedCues();
    expect(cues.insert([{ i: 2, start: 10, end: 14, text: "deux" }, { i: 0, start: 1, end: 2, text: "zéro" }])).toBe(true);
    cues.insert([{ i: 3, start: 12, end: 13, text: "trois" }]);
    expect(cues.cues.map((c) => c.text)).toEqual(["zéro", "deux", "trois"]);
    expect(cues.textAt(12.5)).toBe("deux\ntrois");
    expect(cues.textAt(5)).toBeNull();
  });

  it("une ligne renvoyée remplace l'ancienne ; un lot identique ne change rien", () => {
    const cues = new GeneratedCues();
    cues.insert([{ i: 0, start: 1, end: 2, text: "Bonjour" }]);
    expect(cues.insert([{ i: 0, start: 1, end: 2, text: "Bonjour" }])).toBe(false);
    expect(cues.insert([{ i: 0, start: 1, end: 2, text: "Salut" }])).toBe(true);
    expect(cues.count).toBe(1);
    expect(cues.textAt(1.5)).toBe("Salut");
  });

  it("nettoie le balisage et écarte les lignes vides ou à l'envers", () => {
    const cues = new GeneratedCues();
    cues.insert([
      { i: 0, start: 1, end: 2, text: "<i>Bonjour</i>" },
      { i: 1, start: 3, end: 4, text: "   " },
      { i: 2, start: 6, end: 5, text: "à l'envers" },
    ]);
    expect(cues.count).toBe(1);
    expect(cues.textAt(1.5)).toBe("Bonjour");
  });

  it("couvre un silence entre deux lignes consécutives, pas un passage manquant", () => {
    const cues = new GeneratedCues();
    cues.insert([
      { i: 0, start: 2, end: 3, text: "a" },
      { i: 1, start: 8, end: 9, text: "b" },
      { i: 7, start: 40, end: 41, text: "h" },
      { i: 9, start: 50, end: 51, text: "j" },
    ]);
    expect(cues.covers(1, 10)).toBe(true); // avant la toute première ligne du film
    expect(cues.covers(5, 10)).toBe(true); // silence entre 0 et 1
    expect(cues.covers(20, 10)).toBe(false); // il manque 2 à 6
    expect(cues.covers(60, 10)).toBe(true); // après la dernière ligne du film
    expect(cues.covers(60, 0)).toBe(false); // total inconnu : on ne sait pas
    expect(new GeneratedCues().covers(5, 10)).toBe(false);
  });
});
