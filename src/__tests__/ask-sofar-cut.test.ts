import { describe, it, expect } from "vitest";
import { sofarCut, sofarMark, SOFAR_BUCKET_S } from "@/lib/ask/sofarCut";
import * as client from "@/lib/ask/client";
import * as server from "@/lib/ask/sofar";

// La coupe de « Jusqu'ici » (10.27.2, DECISIONS.md §139) : une seule fonction pour le client et le serveur,
// qui tombe sur le début de la dernière scène d'« À l'écran » avant la marque des cinq minutes.

const payload = (starts: number[], complete = true, analyzedUntil = 0) => ({ complete, analyzedUntil, scenes: starts.map((start) => ({ start })) });

describe("sofarCut", () => {
  it("le début de la dernière scène qui commence au plus tard à la marque", () => {
    expect(sofarMark(17 * 60 + 18)).toBe(900);
    expect(sofarCut(17 * 60 + 18, payload([0, 400, 845.6, 902, 1100]))).toBe(845);
    // Une scène qui commence pile à la marque.
    expect(sofarCut(17 * 60 + 18, payload([0, 900, 1100]))).toBe(900);
  });
  it("jamais au milieu d'une scène, jamais après la marque, jamais négative", () => {
    const starts = [0, 130, 420, 760, 905];
    for (let pos = 0; pos < 1200; pos += 37) {
      const cut = sofarCut(pos, payload(starts));
      expect(cut).toBeLessThanOrEqual(sofarMark(pos));
      expect(cut).toBeGreaterThanOrEqual(0);
      if (cut > 0) expect(starts).toContain(cut);
    }
  });
  it("sans scènes, analyse qui ne va pas jusqu'à la marque, aucune scène avant elle : la marque", () => {
    expect(sofarCut(12 * 60, null)).toBe(600);
    expect(sofarCut(12 * 60, payload([]))).toBe(600);
    expect(sofarCut(12 * 60, payload([0, 300], false, 450))).toBe(600);
    expect(sofarCut(12 * 60, payload([0, 300], false, 650))).toBe(300);
    expect(sofarCut(12 * 60, payload([700, 800]))).toBe(600);
    expect(sofarCut(null, payload([0]))).toBe(0);
  });
  it("le client et le serveur lisent la même tranche, de la même source", () => {
    expect(client.SOFAR_BUCKET_S).toBe(SOFAR_BUCKET_S);
    expect(server.SOFAR_BUCKET_S).toBe(SOFAR_BUCKET_S);
  });
});
