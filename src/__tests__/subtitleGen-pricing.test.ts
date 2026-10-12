import { describe, it, expect } from "vitest";
import { budgetOf, cacheReadRate, costOf, officialPrice, priceFor } from "@/lib/subtitleGen/pricing";

/** Le coût exact (DECISIONS.md §69) : chaque catégorie de jetons à son prix, rien d'inventé. */
describe("pricing", () => {
  it("compte l'entrée, l'écriture et la lecture du cache et la sortie séparément (Haiku 5.5)", () => {
    const price = officialPrice("claude-haiku-5-5")!;
    // 1 M d'entrée à 0,10 ; 1 M écrits à 0,125 (×1,25) ; 1 M relus à 0,01 (×0,1) ; 1 M de sortie à 0,50.
    expect(costOf({ inputTokens: 1e6, cacheWriteTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 }, price)).toBeCloseTo(0.735, 6);
    expect(costOf({ inputTokens: 2000, cacheWriteTokens: 15000, cacheReadTokens: 0, outputTokens: 1000 }, price)).toBeCloseTo((2000 * 0.1 + 15000 * 0.125 + 1000 * 0.5) / 1e6, 10);
  });

  it("applique le tarif de Gemini en vigueur à la date", () => {
    expect(officialPrice("gemini-3.8-flash", Date.UTC(2026, 9, 12))?.input).toBe(0.75);
    expect(officialPrice("gemini-3.8-flash", Date.UTC(2027, 0, 2))?.input).toBe(1.5);
  });

  it("n'invente pas de prix pour un modèle inconnu", () => {
    expect(priceFor("anthropic", "claude-inconnu", { input: "", output: "" })).toBeNull();
    // Un demi-tarif saisi n'est pas un tarif.
    expect(priceFor("anthropic", "claude-inconnu", { input: "1", output: "" })).toBeNull();
  });

  it("prend les deux prix saisis, avec les multiplicateurs du cache du fournisseur", () => {
    expect(priceFor("anthropic", "claude-inconnu", { input: "1", output: "5" })).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
    expect(priceFor("google", "gemini-x", { input: "2,5", output: "10" })).toEqual({ input: 2.5, output: 10, cacheWrite: 2.5, cacheRead: 2.5 });
  });

  it("lit le budget, 5 $ par défaut", () => {
    expect(budgetOf("12,5")).toBe(12.5);
    expect(budgetOf("n'importe quoi")).toBe(5);
  });

  it("donne le taux de lecture du cache", () => {
    expect(cacheReadRate({ inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 900 })).toBe(0.9);
    expect(cacheReadRate({ inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBe(0);
  });
});

describe("les réglages des sous-titres générés", () => {
  it("valident un montant, refusent le reste, et gardent la clé secrète", async () => {
    const { settingProblem } = await import("@/lib/settings/setup");
    const { SETTINGS_BY_KEY } = await import("@/lib/settings/schema");
    expect(settingProblem("SUBTITLE_GEN_BUDGET_USD", "5")).toBeNull();
    expect(settingProblem("SUBTITLE_GEN_BUDGET_USD", "0,75")).toBeNull();
    expect(settingProblem("SUBTITLE_GEN_BUDGET_USD", "")).toBeNull();
    expect(settingProblem("SUBTITLE_GEN_BUDGET_USD", "beaucoup")).toBe("invalid");
    expect(settingProblem("SUBTITLE_GEN_PROVIDER", "mistral")).toBe("invalid");
    expect(SETTINGS_BY_KEY.get("SUBTITLE_GEN_API_KEY")?.kind).toBe("secret");
  });
});
