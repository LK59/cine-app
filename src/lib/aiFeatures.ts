import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { aiAudienceAllows, audienceAllows, type Audience } from "@/lib/featureAudience";
import { budgetOf, costOf, DEFAULT_MODELS, PROVIDERS, priceFor, type BilledUsage, type ProviderName } from "@/lib/subtitleGen/pricing";
import { genSettings, providerFor, ProviderError, type GenSettings, type TranslationCall, type TranslationReply } from "@/lib/subtitleGen/providers";
import { monthOf, spendDb } from "@/lib/subtitleGen/store";
import { taskLog } from "@/lib/taskLog";
import { AI_FEATURES, type AiFeatureId } from "@/lib/aiFeatureTable";
import { estimatedInputUsage } from "@/lib/aiUsage";

// Les relevés de jetons, purs, dans un module à part : la couche des fournisseurs les lit aussi, sans cycle.
export { anthropicUsage, partialAnthropicUsage, estimatedInputUsage, CHARS_PER_TOKEN } from "@/lib/aiUsage";

/**
 * Les fonctions payantes hors sous-titres — recherche décrite (§135), « Précédemment » (§137),
 * questions et « Jusqu'ici » (§139) — chez n'importe lequel des trois fournisseurs, et **un seul
 * plafond mensuel** pour toutes (DECISIONS.md §140, 09/11/2026).
 *
 * **Le modèle** : le rapide du fournisseur (`DEFAULT_MODELS` : Haiku 5.5, gpt-6-luna,
 * gemini-3.8-flash), jamais celui réglé pour les sous-titres — ces réponses s'attendent devant
 * l'écran. Les prix saisis à la main ne valent que s'ils visent ce même modèle.
 *
 * **Le plafond** (`SUBTITLE_GEN_BUDGET_USD`, nom gardé) : la dépense du mois calendaire (UTC) dans
 * `subtitle_gen_spend`, où chaque appel de chaque fonction écrit son coût exact (jetons par catégorie
 * × prix du modèle). Atteint, chaque fonction se coupe proprement : les sous-titres se mettent en
 * pause (`budget`), la recherche décrite et « Précédemment » passent par leur chemin « indisponible »,
 * une question reçoit une ligne d'erreur dite (`budget`), « Jusqu'ici » se tait.
 */

/** Les réglages des fonctions rapides : fournisseur et clé des sous-titres, modèle rapide, son prix. */
export function featureSettings(now = Date.now()): GenSettings {
  // Lu champ par champ, chacun avec son défaut : une configuration partielle (les doubles des tests)
  // ne casse rien, elle vaut « pas de clé ».
  const sg = (config.subtitleGen ?? {}) as Partial<Record<"provider" | "apiKey" | "model" | "priceInput" | "priceOutput", string>> & { enabled?: boolean };
  const raw = sg.provider ?? "anthropic";
  const provider: ProviderName = (PROVIDERS as readonly string[]).includes(raw) ? (raw as ProviderName) : "anthropic";
  const model = DEFAULT_MODELS[provider];
  const configured = (sg.model ?? "").trim() || model;
  const overrides = configured === model ? { input: sg.priceInput ?? "", output: sg.priceOutput ?? "" } : { input: "", output: "" };
  return { enabled: sg.enabled === true, provider, model, hasKey: (sg.apiKey ?? "").trim() !== "", price: priceFor(provider, model, overrides, now) };
}

/**
 * Une clé, et un prix connu — sinon rien ne part (on ne dépense pas sans compter). Lu par la
 * configuration publique à chaque ouverture : une configuration partielle (les doubles des tests)
 * vaut « non », jamais une erreur.
 */
export function featureProviderReady(): boolean {
  try {
    const s = featureSettings();
    return s.hasKey && s.price !== null;
  } catch {
    return false;
  }
}

/** La dépense du mois et le plafond. */
export function aiBudget(now = Date.now()): { spent: number; cap: number; reached: boolean } {
  const spent = spendDb.month(now).cost;
  const cap = budgetOf(config.subtitleGen?.budgetUsd ?? "");
  return { spent, cap, reached: spent >= cap };
}

/**
 * Le plafond est-il atteint ? Une base illisible ne coupe rien : ce contrôle est sur le chemin de
 * chaque fonction, et ne doit pas devenir la panne (« A check that runs on someone else's error path »).
 */
export function aiBudgetReached(now = Date.now()): boolean {
  try {
    return aiBudget(now).reached;
  } catch {
    return false;
  }
}

const NOTICE_KEY = Symbol.for("cine-app.aiBudgetNotice");
const shared = globalThis as typeof globalThis & { [NOTICE_KEY]?: { month: string | null } };
const notice = (shared[NOTICE_KEY] ??= { month: null });

/** Compter un appel ; la première fois que le plafond est franchi dans le mois, une ligne au journal. */
export function recordAiSpend(usage: BilledUsage | null | undefined, price = featureSettings().price, feature: AiFeatureId | "news" = "describe", now = Date.now()): void {
  if (!usage || !price) return;
  try {
    spendDb.add(costOf(usage, price), usage, now, feature);
    const b = aiBudget(now);
    if (b.reached && notice.month !== monthOf(now)) {
      notice.month = monthOf(now);
      taskLog("ia", "plafond mensuel atteint — fonctions payantes coupées jusqu'au mois prochain", { dépensé: b.spent.toFixed(4), plafond: b.cap, par: feature });
    }
  } catch {
    /* compter ne casse jamais la réponse */
  }
}

/**
 * Un appel Anthropic sans flux (recherche décrite, « Précédemment ») : la réponse est comptée par l'appelant ; un
 * appel coupé par le délai du SDK (`APIConnectionTimeoutError`) ou par nous (`APIUserAbortError`) ne rend aucun
 * compteur mais a pu être facturé — son entrée estimée est comptée ici, une fois (10.28.1).
 */
export async function anthropicTimed(
  client: Anthropic,
  system: string,
  message: string,
  feature: AiFeatureId,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  try {
    return await client.messages.create(params);
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionTimeoutError || error instanceof Anthropic.APIUserAbortError) {
      recordAiSpend(estimatedInputUsage(system, message), featureSettings().price, feature);
    }
    throw error;
  }
}

/**
 * Un appel de texte par la couche commune (OpenAI, Gemini — et Anthropic pour qui l'appellerait),
 * compté dans le plafond **une fois**, refus, réponses coupées et appels interrompus compris (ils se paient
 * aussi). Une panne sans jetons connus n'est comptée que si l'appel a été coupé de notre côté (`signal`) :
 * une clé refusée ou un réseau absent n'ont rien coûté.
 */
export async function featureComplete(call: TranslationCall, feature: AiFeatureId): Promise<TranslationReply> {
  const s = featureSettings();
  try {
    const reply = await providerFor(s).complete(call);
    recordAiSpend(reply.usage, s.price, feature);
    return reply;
  } catch (error) {
    const usage = error instanceof ProviderError ? error.usage : null;
    if (usage) recordAiSpend(usage, s.price, feature);
    else if (call.signal?.aborted) recordAiSpend(estimatedInputUsage(call.system, ...call.stable, call.user), s.price, feature);
    throw error;
  }
}

// ── Ce que l'administrateur voit ─────────────────────────────────────────────────────────────────

export type FeatureBlock = "provider" | "price" | "xray" | "budget" | null;

export interface FeatureStatus {
  id: AiFeatureId;
  /** `off` / `admins` / `tous` (un booléen s'y lit `tous` / `off`). */
  audience: Audience;
  /** Ce qui l'empêche de marcher, s'il y a lieu — la carte le dit à côté. */
  blocked: FeatureBlock;
}

function audienceOf(id: AiFeatureId): Audience {
  switch (id) {
    case "subtitles":
      return config.subtitleGen.enabled ? "tous" : "off";
    case "describe":
      return config.describeSearch.enabled ? "tous" : "off";
    case "recap":
      return config.recap.enabled ? "tous" : "off";
    case "askTitle":
      return config.ask.audience;
    case "askPerson":
      return config.ask.personAudience;
    case "sofar":
      return config.ask.sofarAudience;
    case "xray":
      return config.xray.audience;
  }
}

function xrayReady(): boolean {
  return config.xray.enabled && config.xray.url.trim() !== "" && config.xray.apiKey.trim() !== "";
}

/** Chaque fonction : à qui elle est ouverte, et ce qui la bloque (la première raison seulement). */
export function featureStatuses(now = Date.now()): FeatureStatus[] {
  const sub = genSettings(now);
  const fast = featureSettings(now);
  const reached = aiBudgetReached(now);
  return AI_FEATURES.map((f) => {
    const settings = f.id === "subtitles" ? sub : fast;
    let blocked: FeatureBlock = null;
    if (f.needs.includes("provider") && !settings.hasKey) blocked = "provider";
    else if (f.needs.includes("provider") && !settings.price) blocked = "price";
    else if ((f.needs.includes("xray") || f.needs.includes("xrayService")) && !xrayReady()) blocked = "xray";
    else if (f.paid && reached) blocked = "budget";
    return { id: f.id, audience: audienceOf(f.id), blocked };
  });
}

// ── Les portes des questions (§139) ──────────────────────────────────────────────────────────────

type Session = { role?: string | null } | null | undefined;

/**
 * Le public d'un réglage de questions, lu avec méfiance : sans ses propres champs (une configuration
 * partielle), celui des questions sur un titre — la règle même du réglage vide (`config.ask`).
 */
function askAudienceOf(kind: "person" | "sofar"): Audience {
  const a = config.ask as { audience?: Audience; enabled?: boolean; personAudience?: Audience; sofarAudience?: Audience } | undefined;
  const base: Audience = a?.audience ?? (a?.enabled === true ? "tous" : "off");
  return (kind === "person" ? a?.personAudience : a?.sofarAudience) ?? base;
}

/** Les acteurs à l'écran ouverts à cette session et branchés. */
function xrayFor(session: Session): boolean {
  try {
    const x = config.xray as { audience?: Audience; enabled?: boolean; url?: string; apiKey?: string } | undefined;
    const audience: Audience = x?.audience ?? (x?.enabled ? "tous" : "off");
    return audience !== "off" && (x?.url ?? "").trim() !== "" && (x?.apiKey ?? "").trim() !== "" && audienceAllows(audience, session);
  } catch {
    return false;
  }
}

/** Les questions sur une personne : leur public, les acteurs à l'écran, un fournisseur prêt. */
export function askPersonAvailableFor(session: Session): boolean {
  try {
    return aiAudienceAllows(askAudienceOf("person"), session) && xrayFor(session) && featureProviderReady();
  } catch {
    return false;
  }
}

/** « Jusqu'ici » : son public, les acteurs à l'écran, un fournisseur prêt. */
export function sofarAvailableFor(session: Session): boolean {
  try {
    return aiAudienceAllows(askAudienceOf("sofar"), session) && xrayFor(session) && featureProviderReady();
  } catch {
    return false;
  }
}
