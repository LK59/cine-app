import { describe, expect, it } from "vitest";
import { OPEN_SPRING, openStretch } from "@/components/player/LiquidMenu";
import { simulateSpring, springOvershoot } from "@/lib/liquidGlass/spring";

// L'ouverture d'un menu du lecteur (DECISIONS.md §45) : seul le contenant rebondit.
describe("ressorts du menu né de la pilule", () => {
  it("la boîte garde un pop visible mais d'un seul aller-retour, posé vite", () => {
    const over = springOvershoot(OPEN_SPRING);
    expect(over).toBeGreaterThan(0.02);
    expect(over).toBeLessThan(0.06);
    const samples = simulateSpring(0, 1, OPEN_SPRING);
    expect(samples[samples.length - 1].t).toBeLessThan(0.6);
  });

  it("la boîte s'étire en une bosse qui monte et redescend — pas une marche bloquée au plafond", () => {
    const samples = simulateSpring(0, 1, OPEN_SPRING);
    const stretches = samples.map((s) => openStretch(s.v));
    const peak = Math.max(...stretches);
    expect(peak).toBeGreaterThan(0.025);
    expect(peak).toBeLessThanOrEqual(0.03);
    expect(Math.min(...stretches)).toBeGreaterThanOrEqual(-0.015);
    // La première image n'est pas déjà au sommet (la version d'avant y sautait d'un coup)…
    expect(stretches[1]).toBeLessThan(peak * 0.8);
    // … et le sommet n'est atteint qu'une fois : aucun plateau.
    expect(stretches.filter((k) => k >= peak - 1e-9)).toHaveLength(1);
    // Posée, elle a repris sa forme.
    expect(stretches[stretches.length - 1]).toBe(0);
  });
});
