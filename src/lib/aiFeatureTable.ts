import type { ProviderName } from "@/lib/subtitleGen/pricing";

/**
 * Ce que chaque fonction fait avec chaque fournisseur d'IA (DECISIONS.md §140) — la seule liste,
 * lue par la page des réglages (le tableau « qui marche avec quoi ») et par les tests. Rien de
 * serveur ici : la page l'importe telle quelle.
 *
 * Toutes passent par la même couche (`subtitleGen/providers/`) et les mêmes garde-fous, qui ne
 * dépendent pas du fournisseur (fenêtre anti-divulgâcheur, contrôle des noms, mots interdits, cache
 * de 30 jours de « Jusqu'ici », limites, plafond mensuel). Ce qui change d'un fournisseur à l'autre
 * est dit par `notes` — des clés de `aiFeatures.notes.*` — et rien n'est caché : seul Anthropic
 * (Claude Haiku 5.5) a été mesuré sur banc ; ailleurs, la qualité est l'affaire de l'administrateur.
 */

export type AiFeatureId = "subtitles" | "describe" | "recap" | "askTitle" | "askPerson" | "sofar" | "xray";

/** Ce qu'il faut pour qu'une fonction marche : la clé d'un fournisseur, les acteurs à l'écran. */
export type AiNeed = "provider" | "xray" | "xrayService";

/** Une différence entre fournisseurs, nommée (clé `aiFeatures.notes.<note>`). */
export type AiNote =
  | "streamLines"
  | "linesAtEnd"
  | "explicitCache"
  | "implicitCache"
  | "benched"
  | "notBenched"
  | "thinkingAdaptive"
  | "reasoningMapped"
  | "streamSentences"
  | "wholeAnswer"
  | "structured";

export interface AiFeatureRow {
  id: AiFeatureId;
  /** Le réglage qui l'allume (booléen ou public `off` / `admins` / `tous`). */
  setting: string;
  /** Un appel payant au fournisseur, ou un service local gratuit. */
  paid: boolean;
  needs: readonly AiNeed[];
  /** Par fournisseur : ce qui la distingue. Absent : la fonction n'y existe pas (raison dans `onlyWhy`). */
  providers: Partial<Record<ProviderName, readonly AiNote[]>>;
}

const sameEverywhere = (notes: readonly AiNote[]): Record<ProviderName, readonly AiNote[]> => ({ anthropic: notes, openai: notes, google: notes });

export const AI_FEATURES: readonly AiFeatureRow[] = [
  {
    id: "subtitles",
    setting: "SUBTITLE_GEN_ENABLED",
    paid: true,
    needs: ["provider"],
    providers: {
      anthropic: ["streamLines", "explicitCache", "benched"],
      openai: ["linesAtEnd", "implicitCache", "notBenched"],
      google: ["linesAtEnd", "implicitCache", "notBenched"],
    },
  },
  {
    id: "describe",
    setting: "DESCRIBE_SEARCH_ENABLED",
    paid: true,
    needs: ["provider"],
    providers: { anthropic: ["structured", "benched"], openai: ["structured", "notBenched"], google: ["structured", "notBenched"] },
  },
  {
    id: "recap",
    setting: "RECAP_ENABLED",
    paid: true,
    needs: ["provider"],
    providers: {
      anthropic: ["thinkingAdaptive", "benched"],
      openai: ["reasoningMapped", "notBenched"],
      google: ["reasoningMapped", "notBenched"],
    },
  },
  {
    id: "askTitle",
    setting: "ASK_ENABLED",
    paid: true,
    needs: ["provider"],
    providers: {
      anthropic: ["streamSentences", "thinkingAdaptive", "benched"],
      openai: ["wholeAnswer", "reasoningMapped", "notBenched"],
      google: ["wholeAnswer", "reasoningMapped", "notBenched"],
    },
  },
  {
    id: "askPerson",
    setting: "ASK_PERSON_ENABLED",
    paid: true,
    needs: ["provider", "xray"],
    providers: {
      anthropic: ["streamSentences", "thinkingAdaptive", "benched"],
      openai: ["wholeAnswer", "reasoningMapped", "notBenched"],
      google: ["wholeAnswer", "reasoningMapped", "notBenched"],
    },
  },
  {
    id: "sofar",
    setting: "SOFAR_ENABLED",
    paid: true,
    needs: ["provider", "xray"],
    providers: {
      anthropic: ["thinkingAdaptive", "benched"],
      openai: ["reasoningMapped", "notBenched"],
      google: ["reasoningMapped", "notBenched"],
    },
  },
  {
    // Les acteurs à l'écran : un service local, sans fournisseur d'IA ni coût par appel. Les faits TMDB
    // du panneau d'une personne (biographie, ses titres dans la bibliothèque) en font partie.
    id: "xray",
    setting: "XRAY_ENABLED",
    paid: false,
    needs: ["xrayService"],
    providers: sameEverywhere([]),
  },
];
