// Les relevés de jetons des fonctions d'IA (DECISIONS.md §140) — purs, sans base ni configuration : lus par
// `aiFeatures.ts` et par la couche des fournisseurs (`subtitleGen/providers/anthropic.ts`), qui ne peut pas
// importer `aiFeatures.ts` (elle en est une dépendance).

import type { BilledUsage } from "@/lib/subtitleGen/pricing";

/** Les jetons d'une réponse Anthropic, chaque catégorie à part (`input_tokens` n'inclut pas le cache). */
export function anthropicUsage(u: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null | undefined): BilledUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
  };
}

/** Un jeton pour quatre caractères : l'ordre de grandeur d'Anthropic, pour ce qu'aucun compteur ne dit. */
export const CHARS_PER_TOKEN = 4;

/**
 * Les jetons d'un flux Anthropic **interrompu** (10.28.1, DECISIONS.md §140) — le panneau refermé, le filet des
 * noms qui arrête tout, le premier passage d'une question redemandée, le chien de garde. `finalMessage()` rejette
 * alors (`APIUserAbortError`) et ne rend rien, mais Anthropic facture l'entrée et ce qui a été produit : le
 * relevé était perdu, et le plafond ne voyait jamais ces appels. Ce qu'en garde le SDK (1.6.0,
 * `stream.currentMessage`, l'instantané non remis à zéro par l'interruption) :
 * - l'entrée, l'écriture et la lecture du cache — **exactes**, données par `message_start` ;
 * - la sortie : `output_tokens` n'est complet qu'au `message_delta` de la fin, qu'un flux coupé n'a pas reçu —
 *   d'où le plus grand de ce compteur et d'une estimation sur le texte et la réflexion reçus (quatre caractères
 *   par jeton ; une réflexion résumée par l'API sous-estime, jamais l'inverse).
 * `null` : rien reçu (coupé avant `message_start`) — aucun jeton connu, rien à compter.
 */
export function partialAnthropicUsage(
  message:
    | {
        usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null } | null;
        content?: readonly unknown[] | null;
      }
    | null
    | undefined
): BilledUsage | null {
  if (!message?.usage) return null;
  const base = anthropicUsage(message.usage);
  let chars = 0;
  for (const block of message.content ?? []) {
    const b = block as { text?: unknown; thinking?: unknown };
    if (typeof b.text === "string") chars += b.text.length;
    if (typeof b.thinking === "string") chars += b.thinking.length;
  }
  return { ...base, outputTokens: Math.max(base.outputTokens, Math.ceil(chars / CHARS_PER_TOKEN)) };
}

/**
 * Un appel sans flux coupé par nous (OpenAI, Gemini : le panneau refermé) : aucun compteur n'est revenu, mais
 * l'entrée a pu être lue et facturée. Estimée sur le texte envoyé, sans sortie — mieux qu'un appel qui
 * n'existe pas pour le plafond.
 */
export function estimatedInputUsage(...texts: readonly string[]): BilledUsage {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return { inputTokens: Math.ceil(chars / CHARS_PER_TOKEN), cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}
