/**
 * Ce que coûte une traduction, au jeton près (DECISIONS.md §69).
 *
 * Chaque réponse dit combien de jetons elle a lus et écrits ; le prix vient de cette table, ou des
 * réglages quand l'administrateur en a saisi (un modèle que la table ne connaît pas, un tarif qui
 * a changé). **Rien n'est inventé** : un modèle inconnu sans prix saisi n'a pas de coût connu, et
 * la génération refuse de partir (`priceFor` rend null) plutôt que de dépenser sans compter.
 *
 * Prix relevés le 12/10/2026, en dollars par million de jetons, palier standard :
 * - claude-haiku-5-5 : 0,10 / 0,50 (jusqu'à 100 k jetons d'entrée par requête ; une requête porte
 *   le texte entier du film, ~10 à 20 k). Écriture du cache ×1,25 de l'entrée, lecture ×0,1.
 * - gpt-6-luna : 0,10 / 0,50, entrée en cache 0,01 (https://developers.openai.com/api/docs/models/gpt-6-luna).
 *   Le cache y est implicite et ne compte pas d'écriture à part.
 * - gemini-3.8-flash : 0,75 / 3,75 jusqu'au 31/12/2026, puis 1,50 / 7,50
 *   (https://ai.google.dev/gemini-api/docs/pricing — « including thinking tokens »). Le prix des
 *   jetons lus dans son cache implicite n'y est pas relevé : ils sont comptés **au prix plein**
 *   de l'entrée — le compteur surestime plutôt que de sous-estimer.
 */

export type ProviderName = "anthropic" | "openai" | "google";
export const PROVIDERS: readonly ProviderName[] = ["anthropic", "openai", "google"];

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-6-luna",
  google: "gemini-3.8-flash",
};

export interface Price {
  /** Dollars par million de jetons. */
  input: number;
  output: number;
  /** Jetons écrits dans le cache du fournisseur (Anthropic seul les compte à part). */
  cacheWrite: number;
  /** Jetons relus depuis le cache. */
  cacheRead: number;
}

interface PriceRow {
  model: string;
  /** Applicable à partir de cet instant (ms) — un tarif annoncé d'avance. */
  from?: number;
  price: Price;
}

const TABLE: PriceRow[] = [
  { model: "claude-haiku-5-5", price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 } },
  { model: "gpt-6-luna", price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 } },
  { model: "gemini-3.8-flash", price: { input: 0.75, output: 3.75, cacheWrite: 0.75, cacheRead: 0.75 } },
  { model: "gemini-3.8-flash", from: Date.UTC(2027, 0, 1), price: { input: 1.5, output: 7.5, cacheWrite: 1.5, cacheRead: 1.5 } },
];

/**
 * Les multiplicateurs du cache appliqués à un prix d'entrée saisi à la main : ceux qu'Anthropic et
 * OpenAI publient pour leurs modèles (×1,25 l'écriture, ×0,1 la lecture) ; ×1 chez Google, faute
 * de tarif relevé (voir plus haut).
 */
const CACHE_FACTORS: Record<ProviderName, { write: number; read: number }> = {
  anthropic: { write: 1.25, read: 0.1 },
  openai: { write: 1.25, read: 0.1 },
  google: { write: 1, read: 1 },
};

/** Le tarif officiel d'un modèle à cette date, ou null. Le dernier palier entré en vigueur l'emporte. */
export function officialPrice(model: string, now = Date.now()): Price | null {
  let best: PriceRow | null = null;
  for (const row of TABLE) {
    if (row.model !== model) continue;
    if ((row.from ?? 0) > now) continue;
    if (!best || (row.from ?? 0) >= (best.from ?? 0)) best = row;
  }
  return best ? best.price : null;
}

function parseAmount(raw: string): number | null {
  const value = Number(raw.trim().replace(",", "."));
  return raw.trim() !== "" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Le prix retenu : les deux champs des réglages s'ils sont remplis tous deux, la table sinon.
 * Un seul des deux rempli ne vaut rien — un demi-tarif saisi n'est pas un tarif.
 */
export function priceFor(provider: ProviderName, model: string, overrides: { input: string; output: string }, now = Date.now()): Price | null {
  const input = parseAmount(overrides.input);
  const output = parseAmount(overrides.output);
  if (input !== null && output !== null) {
    const f = CACHE_FACTORS[provider];
    return { input, output, cacheWrite: input * f.write, cacheRead: input * f.read };
  }
  return officialPrice(model, now);
}

export interface BilledUsage {
  /** Entrée hors cache. */
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** Le coût exact d'un appel : chaque catégorie de jetons à son prix. */
export function costOf(usage: BilledUsage, price: Price): number {
  return (
    usage.inputTokens * price.input +
    usage.cacheWriteTokens * price.cacheWrite +
    usage.cacheReadTokens * price.cacheRead +
    usage.outputTokens * price.output
  ) / 1_000_000;
}

/** La part de l'entrée relue depuis le cache — ce que le préfixe stable fait gagner. */
export function cacheReadRate(u: Pick<BilledUsage, "inputTokens" | "cacheWriteTokens" | "cacheReadTokens">): number {
  const all = u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens;
  return all > 0 ? Number((u.cacheReadTokens / all).toFixed(3)) : 0;
}

/** Le budget mensuel saisi, en dollars ; un texte illisible vaut le défaut (5 $), jamais l'infini. */
export function budgetOf(raw: string): number {
  return parseAmount(raw) ?? 5;
}
