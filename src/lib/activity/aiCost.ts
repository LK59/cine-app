// Ce que coûtent les fonctions d'IA payantes, affiché à l'administrateur dans Activité (10.27.2, unifié en
// 10.28.0 — DECISIONS.md §140).
//
// **Une seule source : celle du plafond.** Chaque appel payant de chaque fonction (sous-titres générés,
// recherche décrite, « Précédemment », questions, « Jusqu'ici », Nouveautés traduites) écrit son coût exact
// — jetons par catégorie, cache compris, au prix du modèle réellement appelé chez le fournisseur réglé —
// par `spendDb.add`, dans `subtitle_gen_spend` (le mois, que le plafond lit) et `ai_spend_days` (le jour et la
// fonction), dans une même transaction. Les tuiles lisent ces deux tables, et le mois affiché est
// **exactement** la dépense que le plafond compare (`aiBudget`). En 10.27.2, elles recalculaient le coût à
// partir des jetons de `recherche.log` au prix de Haiku : une seconde comptabilité, sans les sous-titres ni
// les autres fournisseurs, qui pouvait dire autre chose que le plafond.
//
// Les jours sont des jours UTC, comme le mois du plafond (la facture des fournisseurs). Les journées
// d'avant 10.28.0 n'existent pas : le mois en cours, lui, est entier (la ligne du mois existait déjà).
//
// En euros au taux fixe `USD_TO_EUR` — **approximatif**, et dit à l'écran (« ≈ », le taux écrit) : la
// dépense et le plafond restent en dollars, la monnaie des fournisseurs.

import type { SpendDay } from "@/lib/subtitleGen/store";

/** Dollars → euros, approximatif (relevé autour de 0,92 à l'automne 2026) — jamais une facture. */
export const USD_TO_EUR = 0.92;

const DAY = 86_400_000;

/** Le jour UTC (AAAA-MM-JJ) de `now` moins `back` jours. */
export function utcDay(now: number, back = 0): string {
  return new Date(now - back * DAY).toISOString().slice(0, 10);
}

export interface AiCostStats {
  /** Dollars, comme le plafond : aujourd'hui (UTC), sept jours, trente jours (aujourd'hui compris). */
  todayUsd: number;
  weekUsd: number;
  days30Usd: number;
  /** La dépense du mois que le plafond compare (`aiBudget().spent`), en dollars. */
  monthUsd: number;
  /** Le plafond mensuel réglé (`SUBTITLE_GEN_BUDGET_USD`), en dollars. */
  capUsd: number;
  /** Trente jours, par fonction (`SpendFeature`) — d'où vient la dépense. */
  byFeature: Record<string, number>;
  /** Les appels payés sur trente jours. */
  calls: number;
  /** Le taux utilisé pour l'affichage en euros. */
  usdToEur: number;
}

/** Les comptes, d'après les journées de `ai_spend_days` (trente au moins) et le mois du plafond. */
export function aiCostStats(days: readonly SpendDay[], budget: { spent: number; cap: number }, now = Date.now()): AiCostStats {
  const today = utcDay(now);
  const week = utcDay(now, 6);
  const days30 = utcDay(now, 29);
  const out: AiCostStats = { todayUsd: 0, weekUsd: 0, days30Usd: 0, monthUsd: budget.spent, capUsd: budget.cap, byFeature: {}, calls: 0, usdToEur: USD_TO_EUR };
  for (const d of days) {
    if (d.day > today || d.day < days30) continue;
    out.days30Usd += d.cost;
    out.calls += d.requests;
    out.byFeature[d.feature] = (out.byFeature[d.feature] ?? 0) + d.cost;
    if (d.day >= week) out.weekUsd += d.cost;
    if (d.day === today) out.todayUsd += d.cost;
  }
  return out;
}

/** Un montant en euros, au centime — au millième sous un euro (un appel coûte une fraction de centime). */
export function euros(value: number, locale?: string): string {
  const digits = value > 0 && value < 1 ? 3 : 2;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** Un montant en dollars, au centime (le plafond est saisi en dollars). */
export function dollars(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
