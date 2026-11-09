import { describe, it, expect, vi } from "vitest";

// Sa propre base : la suite vide et remplit les tables de dépense.
await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "ai-cost-"));
});

import { aiCostStats, dollars, euros, USD_TO_EUR, utcDay } from "@/lib/activity/aiCost";
import { aiCostOf } from "@/lib/activity/dashboard";
import { aiBudget, recordAiSpend } from "@/lib/aiFeatures";
import { spendDb } from "@/lib/subtitleGen/store";
import { getDb } from "@/lib/db";

// Le coût des fonctions d'IA dans Activité (10.27.2 ; 10.28.0, DECISIONS.md §140) : **la source même du
// plafond** — `subtitle_gen_spend` pour le mois, `ai_spend_days` pour les jours et les fonctions, écrites
// ensemble par `spendDb.add` —, plus de second calcul d'après les jetons de `recherche.log`.

const usage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

describe("aiCostStats", () => {
  it("aujourd'hui, sept jours, trente jours (jours UTC), par fonction ; le mois et le plafond tels quels", () => {
    const now = Date.UTC(2026, 10, 9, 15);
    const days = [
      { day: "2026-11-09", feature: "sofar", cost: 0.5, requests: 3 },
      { day: "2026-11-09", feature: "subtitles", cost: 1, requests: 1 },
      { day: "2026-11-03", feature: "askTitle", cost: 0.25, requests: 2 }, // sept jours (3 → 9)
      { day: "2026-11-02", feature: "askTitle", cost: 2, requests: 1 }, // hors des sept jours
      { day: "2026-10-11", feature: "recap", cost: 4, requests: 1 }, // trente jours (11/10 → 09/11)
      { day: "2026-10-10", feature: "recap", cost: 100, requests: 1 }, // trop vieux
    ];
    const s = aiCostStats(days, { spent: 3.75, cap: 80 }, now);
    expect(s.todayUsd).toBeCloseTo(1.5, 10);
    expect(s.weekUsd).toBeCloseTo(1.75, 10);
    expect(s.days30Usd).toBeCloseTo(7.75, 10);
    expect(s.calls).toBe(8);
    expect(s.byFeature).toEqual({ sofar: 0.5, subtitles: 1, askTitle: 2.25, recap: 4 });
    expect(s.monthUsd).toBe(3.75);
    expect(s.capUsd).toBe(80);
    expect(s.usdToEur).toBe(USD_TO_EUR);
  });

  it("les montants à l'écran : euros au millième sous un euro, dollars au centime", () => {
    expect(euros(0.0123, "fr")).toMatch(/0,012\s?€/);
    expect(euros(12.345, "fr")).toMatch(/12,35\s?€/);
    expect(dollars(80, "en")).toBe("$80.00");
  });
});

describe("une seule source : ce que le plafond compte, Activité le montre", () => {
  it("chaque appel enregistré par `recordAiSpend` ou les sous-titres arrive dans le mois du plafond ET dans les jours d'Activité", () => {
    getDb().exec("DELETE FROM subtitle_gen_spend; DELETE FROM ai_spend_days;");
    const now = Date.now();
    const price = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
    // 1 M en entrée + 100 k écrits + 1 M relus + 100 k en sortie : 1 + 0,125 + 0,1 + 0,5 = 1,725 $.
    recordAiSpend({ inputTokens: 1e6, cacheWriteTokens: 1e5, cacheReadTokens: 1e6, outputTokens: 1e5 }, price, "sofar", now);
    spendDb.add(2, usage, now, "subtitles");
    const s = aiCostOf(now);
    expect(s.monthUsd).toBeCloseTo(aiBudget(now).spent, 12);
    expect(s.monthUsd).toBeCloseTo(3.725, 10);
    expect(s.todayUsd).toBeCloseTo(3.725, 10);
    expect(s.byFeature.sofar).toBeCloseTo(1.725, 10);
    expect(s.byFeature.subtitles).toBeCloseTo(2, 10);
    expect(s.calls).toBe(2);
    expect(utcDay(now)).toBe(new Date(now).toISOString().slice(0, 10));
  });
});
