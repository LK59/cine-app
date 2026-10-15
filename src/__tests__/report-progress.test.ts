import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));

import { progressSteps } from "@/components/reports/ReportWizard";
import { REPORT_ZONES } from "@/lib/reportTaxonomy";

// 15/10/2026 (passe de nuit, MOBILE-15) : à la première question de « Signaler un problème », la
// barre était un seul segment plein — « terminé » —, puis quatre segments dont deux pleins.
describe("la barre de progression du signalement", () => {
  it("montre au moins deux étapes avant le choix d'une zone", () => {
    expect(progressSteps({ zone: "", element: null })).toEqual(["zone", "describe"]);
  });

  it("suit le chemin réel une fois la zone choisie", () => {
    const zone = REPORT_ZONES[0];
    const steps = progressSteps({ zone: zone.id, element: null });
    expect(steps[0]).toBe("zone");
    expect(steps[steps.length - 1]).toBe("describe");
  });

  it("est celle que l'assistant dessine", () => {
    const src = readFileSync(join(process.cwd(), "src/components/reports/ReportWizard.tsx"), "utf8");
    expect(src).toContain("{progressSteps(draft).map(");
  });
});
