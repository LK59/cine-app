import { describe, expect, it } from "vitest";
import { ICON_SPRING, OPEN_SPRING, openStretch } from "@/components/player/LiquidMenu";
import { simulateSpring, springOvershoot } from "@/lib/liquidGlass/spring";

// L'ouverture d'un menu du lecteur (DECISIONS.md §45) : seul le contenant rebondit.
describe("ressorts du menu né de la pilule", () => {
  it("l'icône qui glisse jusqu'à l'en-tête ne dépasse pas — elle sortait presque du menu", () => {
    expect(springOvershoot(ICON_SPRING)).toBe(0);
  });

  it("la boîte garde un pop visible mais d'un seul aller-retour, posé vite", () => {
    const over = springOvershoot(OPEN_SPRING);
    expect(over).toBeGreaterThan(0.02);
    expect(over).toBeLessThan(0.06);
    const samples = simulateSpring(0, 1, OPEN_SPRING);
    expect(samples[samples.length - 1].t).toBeLessThan(0.6);
  });

  it("la boîte s'étire en s'ouvrant, visiblement mais sans dépasser 4 %, et se tasse à peine au retour", () => {
    const samples = simulateSpring(0, 1, OPEN_SPRING);
    const stretches = samples.map((s) => openStretch(s.v));
    expect(Math.max(...stretches)).toBeGreaterThan(0.02);
    expect(Math.max(...stretches)).toBeLessThanOrEqual(0.04);
    expect(Math.min(...stretches)).toBeGreaterThanOrEqual(-0.015);
    // Posée, elle a repris sa forme.
    expect(stretches[stretches.length - 1]).toBe(0);
  });
});
