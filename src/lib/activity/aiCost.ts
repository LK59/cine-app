// Ce que coûtent les appels au modèle, d'après `recherche.log` (10.27.2, DECISIONS.md §139) — affiché à
// l'administrateur dans Activité, sous la recherche par description.
//
// **Rien d'estimé au-delà du prix** : chaque ligne qui a vraiment appelé le modèle porte ses jetons
// (`inTokens`, `outTokens`, et depuis 10.27.2 `cacheWrite` / `cacheRead`, le cache de prompts) ; le prix
// vient de la table de `subtitleGen/pricing.ts` (`officialPrice`, Haiku 5.5 : 0,10 $ / 0,50 $ par million,
// écriture du cache ×1,25 de l'entrée, lecture ×0,1). Une ligne sans jetons (un texte gardé, une
// recherche par description servie du cache — ces lignes-là n'en portent pas aujourd'hui) ne coûte rien
// ici. `input_tokens` d'Anthropic ne compte pas les jetons du cache : les trois s'additionnent sans
// double compte.
//
// En euros, au taux fixe `USD_TO_EUR` — **approximatif**, écrit ici et dit à l'écran (« ≈ ») : le
// compteur sert à voir un ordre de grandeur contre la référence du propriétaire (100 € par mois), pas à
// rapprocher une facture.

import { officialPrice, DEFAULT_MODELS } from "@/lib/subtitleGen/pricing";

/** Dollars → euros, approximatif (relevé autour de 0,92 à l'automne 2026) — jamais une facture. */
export const USD_TO_EUR = 0.92;
/** La référence mensuelle du propriétaire (09/11/2026) : le crédit qu'il consacre à ces appels. */
export const AI_MONTHLY_REFERENCE_EUR = 100;

/** Les sortes de lignes qui appellent le modèle, telles que `recherche.log` les nomme. */
export type AiKind = "question" | "jusquici" | "précédemment" | "description";
const KINDS: readonly AiKind[] = ["question", "jusquici", "précédemment", "description"];

export interface AiCostLine {
  _t: number;
  kind?: unknown;
  inTokens?: unknown;
  outTokens?: unknown;
  cacheWrite?: unknown;
  cacheRead?: unknown;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Le coût d'une ligne, en euros ; 0 sans jetons ou pour une autre sorte de ligne. */
export function lineCostEur(line: AiCostLine, now = Date.now()): number {
  if (!KINDS.includes(line.kind as AiKind)) return 0;
  const tokens = num(line.inTokens) + num(line.outTokens) + num(line.cacheWrite) + num(line.cacheRead);
  if (!tokens) return 0;
  const price = officialPrice(DEFAULT_MODELS.anthropic, now);
  if (!price) return 0;
  const usd =
    (num(line.inTokens) * price.input + num(line.outTokens) * price.output + num(line.cacheWrite) * price.cacheWrite + num(line.cacheRead) * price.cacheRead) / 1e6;
  return usd * USD_TO_EUR;
}

export interface AiCostStats {
  /** Euros : depuis minuit (heure du foyer), sept jours, trente jours, depuis le 1er du mois. */
  today: number;
  week: number;
  days30: number;
  month: number;
  reference: number;
  /** Trente jours, par sorte — pour dire d'où vient la dépense. */
  byKind: Record<AiKind, number>;
  /** Les appels qui ont coûté quelque chose, sur trente jours. */
  calls: number;
}

/** Les comptes de `lines` (lignes de `recherche.log`, toutes sortes confondues) à l'instant `now`. */
export function aiCostStats(lines: readonly AiCostLine[], now = Date.now()): AiCostStats {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const monthStart = new Date(midnight);
  monthStart.setDate(1);
  const out: AiCostStats = {
    today: 0,
    week: 0,
    days30: 0,
    month: 0,
    reference: AI_MONTHLY_REFERENCE_EUR,
    byKind: { question: 0, jusquici: 0, précédemment: 0, description: 0 },
    calls: 0,
  };
  for (const line of lines) {
    if (line._t > now) continue;
    const eur = lineCostEur(line, line._t);
    if (!eur) continue;
    if (line._t >= midnight.getTime()) out.today += eur;
    if (line._t >= now - 7 * 86_400_000) out.week += eur;
    if (line._t >= now - 30 * 86_400_000) {
      out.days30 += eur;
      out.byKind[line.kind as AiKind] += eur;
      out.calls += 1;
    }
    if (line._t >= monthStart.getTime()) out.month += eur;
  }
  return out;
}

/** Un montant en euros, au centime — au millième sous un euro (un appel coûte une fraction de centime). */
export function euros(value: number, locale?: string): string {
  const digits = value > 0 && value < 1 ? 3 : 2;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
