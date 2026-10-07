import { describe, expect, it } from "vitest";
import { ICON_SPRING, OPEN_SPRING } from "@/components/player/LiquidMenu";
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
});
