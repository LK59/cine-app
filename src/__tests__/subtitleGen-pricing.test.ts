import { describe, it, expect } from "vitest";
import { budgetOf, cacheReadRate, costOf, officialPrice, priceFor } from "@/lib/subtitleGen/pricing";

/** Le coût exact (DECISIONS.md §69) : chaque catégorie de jetons à son prix, rien d'inventé. */
describe("pricing", () => {
  it("compte l'entrée, l'écriture et la lecture du cache et la sortie séparément (Haiku 5.5)", () => {
    const price = officialPrice("claude-haiku-5-5")!;
    // 30 k d'entrée à 0,10 ; 30 k écrits à 0,125 (×1,25) ; 30 k relus à 0,01 (×0,1) ; 1 M de sortie à 0,50
    // — une invite de 90 k, sous le palier de 100 k.
    expect(costOf({ inputTokens: 3e4, cacheWriteTokens: 3e4, cacheReadTokens: 3e4, outputTokens: 1e6 }, price)).toBeCloseTo((3e4 * 0.1 + 3e4 * 0.125 + 3e4 * 0.01) / 1e6 + 0.5, 9);
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
    // Google et OpenAI : lecture du cache à ×0,1 (leurs modèles courants, relevé du 09/11/2026), sans écriture à part.
    expect(priceFor("google", "gemini-x", { input: "2,5", output: "10" })).toEqual({ input: 2.5, output: 10, cacheWrite: 2.5, cacheRead: 0.25 });
    expect(priceFor("openai", "gpt-x", { input: "1", output: "4" })).toEqual({ input: 1, output: 4, cacheWrite: 1, cacheRead: 0.1 });
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

/** Le relevé du 09/11/2026 (§140) : chaque fournisseur, ses jetons de cache, ses paliers d'invite longue. */
describe("les tarifs relevés le 09/11/2026", () => {
  const u = (inputTokens: number, cacheWriteTokens: number, cacheReadTokens: number, outputTokens: number) => ({ inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens });

  it("Haiku 5.5 : au-delà de 100 000 jetons d'invite (cache compris), toute la requête au palier long", async () => {
    const { costOf, officialPrice } = await import("@/lib/subtitleGen/pricing");
    const price = officialPrice("claude-haiku-5-5")!;
    // 60 k d'entrée + 50 k relus = 110 k : 0,50 / 0,05 / 2,50.
    expect(costOf(u(60_000, 0, 50_000, 1000), price)).toBeCloseTo((60_000 * 0.5 + 50_000 * 0.05 + 1000 * 2.5) / 1e6, 10);
    // 100 000 tout juste : le palier ordinaire.
    expect(costOf(u(100_000, 0, 0, 0), price)).toBeCloseTo(0.01, 10);
  });

  it("Anthropic : la lecture du cache de Sonnet 5.5 et Opus 5.5 vaut ×0,05, celle de Fable 5.1 ×0,025", async () => {
    const { officialPrice } = await import("@/lib/subtitleGen/pricing");
    expect(officialPrice("claude-sonnet-5-5")).toEqual({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 });
    expect(officialPrice("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 });
    expect(officialPrice("claude-fable-5-1")).toEqual({ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 });
  });

  it("OpenAI : l'entrée en cache à son prix, le palier long au-delà de 272 000 jetons", async () => {
    const { costOf, officialPrice } = await import("@/lib/subtitleGen/pricing");
    const luna = officialPrice("gpt-6-luna")!;
    expect(costOf(u(1000, 0, 9000, 500), luna)).toBeCloseTo((1000 * 0.1 + 9000 * 0.01 + 500 * 0.5) / 1e6, 12);
    expect(costOf(u(200_000, 0, 100_000, 0), luna)).toBeCloseTo((200_000 * 0.2 + 100_000 * 0.02) / 1e6, 12);
  });

  it("Google : la lecture du cache implicite à son prix, et les deux changements de tarif annoncés", async () => {
    const { costOf, officialPrice } = await import("@/lib/subtitleGen/pricing");
    const flash = officialPrice("gemini-3.8-flash", Date.UTC(2026, 10, 9))!;
    expect(costOf(u(1000, 0, 4000, 200), flash)).toBeCloseTo((1000 * 0.75 + 4000 * 0.075 + 200 * 3.75) / 1e6, 12);
    expect(officialPrice("gemini-3.8-flash", Date.UTC(2027, 0, 1))?.cacheRead).toBe(0.15);
    expect(officialPrice("gemini-4-argon", Date.UTC(2026, 10, 30))?.input).toBe(2);
    expect(officialPrice("gemini-4-argon", Date.UTC(2026, 11, 1))?.input).toBe(4);
  });

  it("propose une liste par fournisseur, le modèle rapide d'abord, et rien qu'elle ne sache chiffrer", async () => {
    const { modelChoices, officialPrice, DEFAULT_MODELS, PROVIDERS } = await import("@/lib/subtitleGen/pricing");
    for (const p of PROVIDERS) {
      const list = modelChoices(p);
      expect(list[0]).toBe(DEFAULT_MODELS[p]);
      for (const m of list) expect(officialPrice(m), m).not.toBeNull();
    }
    expect(modelChoices("anthropic")).toContain("claude-sonnet-5-5");
    expect(modelChoices("openai")).toContain("gpt-6.1-terra");
    expect(modelChoices("google")).toContain("gemini-3.5-flash-lite");
  });
});
