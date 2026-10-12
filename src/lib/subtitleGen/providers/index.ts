import { config } from "@/lib/config";
import { DEFAULT_MODELS, PROVIDERS, priceFor, type Price, type ProviderName } from "../pricing";
import { anthropicProvider } from "./anthropic";
import { googleProvider } from "./google";
import { openaiProvider } from "./openai";
import type { TranslationProvider } from "./types";

export * from "./types";

/** Ce que les réglages disent, relu à chaque appel (DECISIONS.md §48). */
export interface GenSettings {
  enabled: boolean;
  provider: ProviderName;
  model: string;
  hasKey: boolean;
  price: Price | null;
}

export function genSettings(now = Date.now()): GenSettings {
  const raw = config.subtitleGen.provider;
  const provider: ProviderName = (PROVIDERS as readonly string[]).includes(raw) ? (raw as ProviderName) : "anthropic";
  const model = config.subtitleGen.model.trim() || DEFAULT_MODELS[provider];
  return {
    enabled: config.subtitleGen.enabled,
    provider,
    model,
    hasKey: config.subtitleGen.apiKey.trim() !== "",
    price: priceFor(provider, model, { input: config.subtitleGen.priceInput, output: config.subtitleGen.priceOutput }, now),
  };
}

/** La fonction existe-t-elle ? Une clé, la fonction allumée, et un prix connu (sinon on ne compte pas). */
export function genAvailable(s: GenSettings = genSettings()): boolean {
  return s.enabled && s.hasKey && s.price !== null;
}

function realProvider(s: GenSettings): TranslationProvider {
  const key = config.subtitleGen.apiKey.trim();
  if (s.provider === "openai") return openaiProvider(key, s.model);
  if (s.provider === "google") return googleProvider(key, s.model);
  return anthropicProvider(key, s.model);
}

/** Le fournisseur des réglages. Remplaçable par les tests — aucun appel réseau réel n'y part. */
let factory: (s: GenSettings) => TranslationProvider = realProvider;

export function providerFor(s: GenSettings): TranslationProvider {
  return factory(s);
}

export function setProviderFactoryForTests(f: ((s: GenSettings) => TranslationProvider) | null): void {
  factory = f ?? realProvider;
}
