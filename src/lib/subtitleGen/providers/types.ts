import type { BilledUsage, ProviderName } from "../pricing";

/**
 * Ce que le moteur demande à un fournisseur d'IA, quel qu'il soit (DECISIONS.md §69).
 *
 * Une seule forme d'appel : des consignes, un message, et soit un schéma JSON que la réponse doit
 * suivre (le glossaire), soit du texte libre en lignes `id|traduction` (les lots, lus et vérifiés
 * par `validate.ts`). Pas d'outils, jamais : le texte des sous-titres est une donnée, et un modèle sans outil ne peut
 * rien faire d'autre que répondre — c'est la première défense contre une réplique qui
 * ressemblerait à une instruction.
 */
export interface TranslationCall {
  /** Les consignes. */
  system: string;
  /**
   * Le reste du **préfixe stable** : glossaire et texte source complet, identiques octet pour octet
   * d'un lot à l'autre d'une même tâche. Envoyés après les consignes, avant le message — c'est ce
   * préfixe que le cache du fournisseur relit à 10 % du prix (Anthropic : point de cache explicite
   * sur son dernier bloc ; OpenAI et Gemini : cache implicite des préfixes identiques).
   */
  stable: string[];
  /** Poser le point de cache explicite (Anthropic). Faux pour un appel unique, qui paierait l'écriture pour rien. */
  cache: boolean;
  /** Le suffixe variable : le contexte proche et les lignes à traduire. */
  user: string;
  /**
   * Le schéma de la réponse ; `additionalProperties: false` partout (exigé par les trois). Absent :
   * la réponse est du texte libre, rendu tel quel dans `text` (les lots, DECISIONS.md §69).
   */
  schema?: Record<string, unknown>;
  schemaName: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /**
   * Le texte au fil de sa production, pour écrire chaque ligne dès qu'elle est complète. Anthropic
   * seulement (flux du SDK) ; OpenAI et Gemini l'ignorent et rendent la réponse d'un bloc — le
   * moteur s'en accommode : les lignes sont alors écrites à la fin du lot.
   */
  onText?: (delta: string) => void;
}

/**
 * Les jetons d'un appel, chaque catégorie à part : entrée hors cache, écrite dans le cache, relue du
 * cache, sortie (réflexion comprise — Gemini la compte à part, au prix de la sortie).
 */
export type Usage = BilledUsage;

export interface TranslationReply {
  /** Le JSON de la réponse, déjà analysé quand un schéma était demandé — sa forme est vérifiée par l'appelant. */
  json?: unknown;
  /** Le texte de la réponse, tel quel. */
  text: string;
  usage: Usage;
}

/**
 * Pourquoi un appel n'a rien rendu d'utilisable. Le moteur décide d'après ce seul champ :
 * - `rate`, `server`, `network` : passager — nouvel essai avec attente croissante, puis pause ;
 * - `auth` : clé refusée — pause `config` de toutes les tâches ;
 * - `credit` : crédit du compte épuisé — pause `budget` de toutes les tâches ;
 * - `config` : modèle inconnu, requête refusée par l'API — pause `config` ;
 * - `refusal` : le modèle refuse ce lot — découpé, puis la ligne garde son texte source ;
 * - `truncated`, `invalid` : réponse coupée ou illisible — même traitement qu'un lot invalide.
 */
export type ProviderErrorKind = "rate" | "server" | "network" | "auth" | "credit" | "config" | "refusal" | "truncated" | "invalid";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** Les jetons facturés malgré l'échec (un refus, une réponse coupée se paient). */
    readonly usage: Usage | null = null
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface TranslationProvider {
  readonly name: ProviderName;
  readonly model: string;
  complete(call: TranslationCall): Promise<TranslationReply>;
}

/** Une erreur HTTP d'un appel REST, rangée dans les catégories ci-dessus. */
export function kindOfStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate";
  if (status === 408 || status >= 500) return "server";
  return "config";
}

/** Un message d'erreur sans rien de la requête : la clé n'y figure jamais, le texte non plus. */
export function safeMessage(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 200);
}

/** La réponse d'un appel : le JSON analysé si un schéma était demandé, toujours le texte. */
export function replyOf(call: Pick<TranslationCall, "schema">, text: string, usage: Usage): TranslationReply {
  return call.schema ? { json: parseJsonText(text, usage), text, usage } : { text, usage };
}

/** Lire une réponse JSON qui doit en être une ; sinon `invalid`. */
export function parseJsonText(text: string, usage: Usage): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("invalid", "réponse non JSON", usage);
  }
}
