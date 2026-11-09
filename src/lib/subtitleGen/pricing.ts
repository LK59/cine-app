/**
 * Ce que coûte un appel au fournisseur d'IA, au jeton près (DECISIONS.md §69, §140).
 *
 * Chaque réponse dit combien de jetons elle a lus et écrits ; le prix vient de cette table, ou des
 * réglages quand l'administrateur en a saisi (un modèle que la table ne connaît pas, un tarif qui
 * a changé). **Rien n'est inventé** : un modèle inconnu sans prix saisi n'a pas de coût connu, et
 * les fonctions payantes refusent de partir (`priceFor` rend null) plutôt que de dépenser sans compter.
 *
 * **Prix relevés le 09/11/2026** sur les pages officielles, en dollars par million de jetons, palier
 * standard (ni lot, ni priorité, ni « flex ») :
 * - Anthropic — https://platform.claude.com/docs/en/about-claude/pricing : entrée, écriture du cache
 *   (5 min, ×1,25), lecture du cache, sortie. La lecture vaut ×0,1 de l'entrée, sauf Opus 5.5 et
 *   Sonnet 5.5 (×0,05) et Fable 5.1 (×0,025). Haiku 5.5 a deux paliers : une requête dont l'invite
 *   dépasse 100 000 jetons (cache compris) paie 0,50 / 2,50 au lieu de 0,10 / 0,50.
 * - OpenAI — https://developers.openai.com/api/docs/pricing : entrée, entrée en cache, sortie ;
 *   au-delà de 272 000 jetons d'entrée, le palier « long context ». Le cache que nous utilisons est
 *   l'implicite (préfixes identiques) : la réponse ne compte aucune écriture à part.
 * - Google — https://aistudio.google.com/docs/pricing (ex-ai.google.dev/gemini-api/docs/pricing) :
 *   entrée texte, sortie réflexion comprise, « context caching » (le prix des jetons relus). Le
 *   stockage horaire d'un cache explicite ne nous concerne pas : nous n'en créons pas. Deux modèles
 *   changent de prix à date annoncée (`from`). Avant ce relevé, la lecture du cache de
 *   gemini-3.8-flash était comptée au prix plein faute de tarif publié ; il l'est (0,075).
 * Un modèle cité sur ces pages mais retiré, en aperçu, réservé (Mythos, gpt-*-pro) ou annoncé
 * « deprecated » n'est pas repris. Un modèle absent d'ici se règle par les deux prix saisis.
 */

export type ProviderName = "anthropic" | "openai" | "google";
export const PROVIDERS: readonly ProviderName[] = ["anthropic", "openai", "google"];

/** Le jour des relevés de `TABLE` — montré dans les réglages. */
export const PRICES_VERIFIED_ON = "2026-11-09";
export const PRICE_SOURCES: Record<ProviderName, string> = {
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
  openai: "https://developers.openai.com/api/docs/pricing",
  google: "https://aistudio.google.com/docs/pricing",
};

/**
 * Le modèle rapide de chaque fournisseur : celui des sous-titres quand le réglage est vide, et celui
 * de toutes les autres fonctions (recherche décrite, « Précédemment », questions, « Jusqu'ici »),
 * qui répondent pendant qu'on attend — le modèle réglé pour les sous-titres peut être plus lent.
 */
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
  /**
   * Un palier d'invite longue : une requête dont l'invite (entrée, cache écrit et relu) dépasse
   * `above` jetons paie `price` en entier (Haiku 5.5 au-delà de 100 k, OpenAI au-delà de 272 k).
   */
  long?: { above: number; price: Omit<Price, "long"> };
}

interface PriceRow {
  provider: ProviderName;
  model: string;
  /** Applicable à partir de cet instant (ms) — un tarif annoncé d'avance. */
  from?: number;
  price: Price;
}

const p = (input: number, output: number, cacheWrite: number, cacheRead: number, long?: Price["long"]): Price => ({
  input,
  output,
  cacheWrite,
  cacheRead,
  ...(long ? { long } : {}),
});
/** OpenAI : entrée, entrée en cache, sortie — aucune écriture comptée par le cache implicite. */
const oa = (input: number, cached: number, output: number, long?: [number, number, number]): Price =>
  p(input, output, input, cached, long ? { above: 272_000, price: { input: long[0], cacheRead: long[1], output: long[2], cacheWrite: long[0] } } : undefined);
/** Google : entrée, sortie, lecture du cache — le cache implicite n'écrit rien de facturé. */
const gg = (input: number, output: number, cached: number): Price => p(input, output, input, cached);

const TABLE: PriceRow[] = [
  // Anthropic (écriture = cache de 5 minutes, celui que pose `cache_control: ephemeral`).
  { provider: "anthropic", model: "claude-haiku-5-5", price: p(0.1, 0.5, 0.125, 0.01, { above: 100_000, price: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } }) },
  { provider: "anthropic", model: "claude-sonnet-5-5", price: p(2, 10, 2.5, 0.1) },
  { provider: "anthropic", model: "claude-opus-5-5", price: p(4, 20, 5, 0.2) },
  { provider: "anthropic", model: "claude-fable-5-1", price: p(10, 50, 12.5, 0.25) },
  { provider: "anthropic", model: "claude-sonnet-5", price: p(2, 10, 2.5, 0.2) },
  { provider: "anthropic", model: "claude-opus-5", price: p(5, 25, 6.25, 0.5) },
  { provider: "anthropic", model: "claude-haiku-4-5", price: p(1, 5, 1.25, 0.1) },
  // OpenAI (entrée, entrée en cache, sortie ; palier long au-delà de 272 k).
  { provider: "openai", model: "gpt-6-luna", price: oa(0.1, 0.01, 0.5, [0.2, 0.02, 0.75]) },
  { provider: "openai", model: "gpt-6.1-terra", price: oa(1, 0.05, 5, [2, 0.1, 7.5]) },
  { provider: "openai", model: "gpt-6.1-sol", price: oa(2, 0.1, 10, [4, 0.2, 15]) },
  { provider: "openai", model: "gpt-6-sol", price: oa(2, 0.2, 10, [4, 0.4, 15]) },
  { provider: "openai", model: "gpt-6-astra", price: oa(10, 1, 50, [20, 2, 75]) },
  { provider: "openai", model: "gpt-5.4-mini", price: oa(0.75, 0.075, 4.5) },
  { provider: "openai", model: "gpt-5.4-nano", price: oa(0.2, 0.02, 1.25) },
  // Google (entrée texte, sortie réflexion comprise, lecture du cache).
  { provider: "google", model: "gemini-3.8-flash", price: gg(0.75, 3.75, 0.075) },
  { provider: "google", model: "gemini-3.8-flash", from: Date.UTC(2027, 0, 1), price: gg(1.5, 7.5, 0.15) },
  { provider: "google", model: "gemini-4-argon", price: gg(2, 10, 0.1) },
  { provider: "google", model: "gemini-4-argon", from: Date.UTC(2026, 11, 1), price: gg(4, 20, 0.2) },
  { provider: "google", model: "gemini-3.5-flash-lite", price: gg(0.3, 2.5, 0.03) },
  { provider: "google", model: "gemini-3.1-flash-lite", price: gg(0.25, 1.5, 0.025) },
];

/** Les modèles proposés pour un fournisseur (le champ accepte aussi un autre nom). Le défaut d'abord. */
export function modelChoices(provider: ProviderName): string[] {
  const own = [...new Set(TABLE.filter((r) => r.provider === provider).map((r) => r.model))];
  return [DEFAULT_MODELS[provider], ...own.filter((m) => m !== DEFAULT_MODELS[provider])];
}

/**
 * Les multiplicateurs du cache appliqués à un prix d'entrée saisi à la main : ceux qu'Anthropic
 * publie pour l'ordinaire de ses modèles (×1,25 l'écriture, ×0,1 la lecture) ; ×0,1 la lecture chez
 * OpenAI et Google (leurs modèles courants), sans écriture facturée à part chez eux.
 */
const CACHE_FACTORS: Record<ProviderName, { write: number; read: number }> = {
  anthropic: { write: 1.25, read: 0.1 },
  openai: { write: 1, read: 0.1 },
  google: { write: 1, read: 0.1 },
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

/** Le coût exact d'un appel : chaque catégorie de jetons à son prix — au palier long si l'invite le dépasse. */
export function costOf(usage: BilledUsage, base: Price): number {
  const prompt = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  const price = base.long && prompt > base.long.above ? base.long.price : base;
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

/**
 * Le plafond mensuel saisi, en dollars ; un texte illisible vaut le défaut (5 $), jamais l'infini.
 * Depuis le 09/11/2026 (§140), un plafond pour **toutes** les fonctions payantes, pas seulement les
 * sous-titres générés.
 */
export function budgetOf(raw: string): number {
  return parseAmount(raw) ?? 5;
}
