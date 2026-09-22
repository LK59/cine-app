import { describe, it, expect } from "vitest";
import { reachable, seekArrived } from "@/lib/webcodecs/seekArrival";

// Les deux règles d'un saut, écrites une fois pour la source, l'hôte et le banc (22/09/2026).
describe("règles d'un saut", () => {
  it("dit arrivé à 1,5 s près de la cible, dans les deux sens", () => {
    expect(seekArrived(601.4, 600)).toBe(true);
    expect(seekArrived(598.6, 600)).toBe(true);
    expect(seekArrived(612, 600)).toBe(false);
  });

  it("ne rejoint une position d'un fichier sans index qu'au tout début", () => {
    expect(reachable(true, 5000)).toBe(true);
    expect(reachable(false, 0.5)).toBe(true);
    expect(reachable(false, 600)).toBe(false);
  });
});
