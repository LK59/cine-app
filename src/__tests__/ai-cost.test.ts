import { describe, it, expect } from "vitest";
import { aiCostStats, euros, lineCostEur, USD_TO_EUR, AI_MONTHLY_REFERENCE_EUR } from "@/lib/activity/aiCost";

// Le coût des appels au modèle (10.27.2, DECISIONS.md §139) : les jetons de `recherche.log` au prix de
// Haiku 5.5 (0,10 $ / 0,50 $ par million, cache ×1,25 à l'écriture, ×0,1 à la lecture), en euros au taux
// fixe et approximatif `USD_TO_EUR`.

describe("lineCostEur", () => {
  it("entrée, sortie, écriture et lecture du cache, chacune à son prix", () => {
    const t = Date.UTC(2026, 10, 9);
    // 1 M de chaque : 0,10 + 0,50 + 0,125 + 0,01 = 0,735 $.
    expect(lineCostEur({ _t: t, kind: "question", inTokens: 1e6, outTokens: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }, t)).toBeCloseTo(0.735 * USD_TO_EUR, 10);
    // Une ligne réelle (banc du 09/11/2026) : 86 en entrée, 523 en sortie, 6 659 relus du cache.
    expect(lineCostEur({ _t: t, kind: "jusquici", inTokens: 86, outTokens: 523, cacheWrite: 0, cacheRead: 6659 }, t)).toBeCloseTo(
      ((86 * 0.1 + 523 * 0.5 + 6659 * 0.01) / 1e6) * USD_TO_EUR,
      12
    );
  });
  it("sans jetons, ou une autre sorte de ligne : rien", () => {
    expect(lineCostEur({ _t: 0, kind: "jusquici" })).toBe(0);
    expect(lineCostEur({ _t: 0, kind: "description" })).toBe(0);
    expect(lineCostEur({ _t: 0, kind: "autre", inTokens: 1e6 })).toBe(0);
    // Des jetons sur une recherche par description seraient comptés.
    expect(lineCostEur({ _t: 0, kind: "description", inTokens: 1e6 })).toBeGreaterThan(0);
  });
});

describe("aiCostStats", () => {
  it("aujourd'hui, sept jours, trente jours, le mois en cours, par sorte", () => {
    // Le 9 novembre 2026, 15 h (heure du foyer, `TZ` de la suite).
    const now = new Date(2026, 10, 9, 15).getTime();
    const big = { inTokens: 1e6, outTokens: 0 };
    const lines = [
      { _t: new Date(2026, 10, 9, 10).getTime(), kind: "question", ...big }, // aujourd'hui
      { _t: new Date(2026, 10, 8, 23).getTime(), kind: "jusquici", ...big }, // hier : sept jours, mois
      { _t: new Date(2026, 9, 31, 12).getTime(), kind: "précédemment", ...big }, // octobre : trente jours, pas le mois
      { _t: new Date(2026, 9, 1, 12).getTime(), kind: "question", ...big }, // trop vieux
      { _t: new Date(2026, 10, 9, 11).getTime(), kind: "description", status: "ok" }, // sans jetons
    ];
    const unit = 0.1 * USD_TO_EUR;
    const s = aiCostStats(lines, now);
    expect(s.today).toBeCloseTo(unit, 10);
    expect(s.week).toBeCloseTo(2 * unit, 10);
    expect(s.days30).toBeCloseTo(3 * unit, 10);
    expect(s.month).toBeCloseTo(2 * unit, 10);
    expect(s.calls).toBe(3);
    expect(s.byKind.précédemment).toBeCloseTo(unit, 10);
    expect(s.reference).toBe(AI_MONTHLY_REFERENCE_EUR);
  });

  it("le montant à l'écran : au millième sous un euro, au centime au-delà", () => {
    expect(euros(0.0123, "fr")).toMatch(/0,012\s?€/);
    expect(euros(12.345, "fr")).toMatch(/12,35\s?€/);
  });
});
