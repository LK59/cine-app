import { describe, it, expect } from "vitest";
import { simulateSpring, springKeyframes, springOvershoot } from "@/components/animlab/spring";

describe("le ressort de la page Tests animations", () => {
  it("se pose exactement sur sa cible", () => {
    const samples = simulateSpring(0.9, 1, { stiffness: 400, damping: 22 });
    expect(samples[0].x).toBe(0.9);
    expect(samples[samples.length - 1].x).toBe(1);
  });

  it("dépasse quand il est peu amorti, et pas quand il l'est critiquement", () => {
    expect(springOvershoot({ stiffness: 400, damping: 10 })).toBeGreaterThan(0.2);
    // 2·√400 = 40 : amortissement critique, aucun dépassement visible.
    expect(springOvershoot({ stiffness: 400, damping: 40 })).toBeLessThan(0.002);
  });

  it("rend des images clés ordonnées de 0 à 1, avec une durée à la mesure du ressort", () => {
    const { keyframes, duration } = springKeyframes(0, 1, { stiffness: 300, damping: 20 }, (s) => ({ transform: `scale(${s.x})` }));
    const offsets = keyframes.map((k) => k.offset as number);
    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(1);
    expect(offsets.every((o, i) => i === 0 || o >= offsets[i - 1])).toBe(true);
    expect(duration).toBeGreaterThan(100);
    expect(duration).toBeLessThanOrEqual(2600);
  });

  it("tient compte d'une vitesse de départ", () => {
    const still = simulateSpring(0, 0, { stiffness: 300, damping: 12 });
    const thrown = simulateSpring(0, 0, { stiffness: 300, damping: 12 }, 5);
    expect(still.length).toBeLessThanOrEqual(2);
    expect(Math.max(...thrown.map((s) => s.x))).toBeGreaterThan(0.1);
  });
});
