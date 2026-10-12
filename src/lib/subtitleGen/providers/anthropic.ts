import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, replyOf, safeMessage, type TranslationCall, type TranslationProvider, type TranslationReply } from "./types";

/**
 * Anthropic, par le SDK officiel (`@anthropic-ai/sdk`).
 *
 * Pour Haiku 5.5 : réflexion coupée (`thinking: disabled`, accepté seulement à l'effort `high` ou
 * moins — d'où `effort: "low"`), sortie structurée par `output_config.format` pour le glossaire. Traduire un lot de
 * quarante répliques n'a pas besoin de réfléchir, et la réflexion se paie au prix de la sortie.
 * Un autre modèle saisi dans les réglages ne reçoit pas `disabled` : Opus 5.5 et Sonnet 5.5 le
 * refusent d'un 400 — l'effort bas suffit alors à la borner.
 *
 * **En flux pour les lots** (`messages.stream`, quand l'appelant passe `onText`) : chaque ligne
 * `id|traduction` est écrite en base dès qu'elle est complète, et le lecteur l'affiche sans attendre
 * la fin du lot — le premier jeton arrive en ~1 s, le lot de quarante en ~4-5 s (banc du 12/10/2026).
 * Le glossaire, en JSON, n'en a pas besoin. Pas de nouvel essai du SDK (`maxRetries: 0`) : le
 * moteur a les siens, qui tiennent compte du budget et de la priorité des spectateurs entre deux
 * essais.
 *
 * Un refus (`stop_reason: "refusal"`) n'a pas de repli côté serveur pour Haiku 5.5 : il remonte
 * tel quel, et le moteur garde la réplique en langue source.
 */
export function anthropicProvider(apiKey: string, model: string): TranslationProvider {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 90_000 });
  const thinkingOff = model.startsWith("claude-haiku");
  return {
    name: "anthropic",
    model,
    async complete(call: TranslationCall): Promise<TranslationReply> {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: call.maxOutputTokens,
        // Les consignes, puis le préfixe stable ; le point de cache sur son dernier bloc. Rien de
        // variable avant lui : la position, le contexte proche et les lignes demandées sont dans
        // le message, après.
        system: [call.system, ...call.stable].map((text, i, all) => ({
          type: "text" as const,
          text,
          ...(call.cache && i === all.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
        })),
        messages: [{ role: "user", content: call.user }],
        ...(thinkingOff ? { thinking: { type: "disabled" as const } } : {}),
        // Sans schéma (les lots), du texte libre en lignes `id|traduction`.
        output_config: { effort: "low", ...(call.schema ? { format: { type: "json_schema" as const, schema: call.schema } } : {}) },
      };
      let res: Anthropic.Message;
      try {
        if (call.onText) {
          const onText = call.onText;
          const stream = client.messages.stream(params, { signal: call.signal });
          stream.on("text", (delta) => {
            // Ce qu'en fait l'appelant ne doit pas rompre le flux : son erreur resterait sans nom ici.
            try {
              onText(delta);
            } catch {
              /* ignorée : la validation du lot entier, à la fin, tranche */
            }
          });
          res = await stream.finalMessage();
        } else {
          res = await client.messages.create(params, { signal: call.signal });
        }
      } catch (error) {
        throw classify(error);
      }
      // `input_tokens` n'inclut ni l'écriture ni la lecture du cache : trois prix, trois compteurs.
      const usage = {
        inputTokens: res.usage.input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        outputTokens: res.usage.output_tokens ?? 0,
      };
      // Le motif d'arrêt avant le contenu : un refus ou une réponse coupée ne suivent pas le schéma.
      if (res.stop_reason === "refusal") throw new ProviderError("refusal", `refus (${res.stop_details?.category ?? "sans catégorie"})`, usage);
      if (res.stop_reason === "max_tokens") throw new ProviderError("truncated", "réponse coupée (max_tokens)", usage);
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return replyOf(call, text, usage);
    },
  };
}

function classify(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  // Du plus précis au plus général : chaque classe du SDK étend `APIError`.
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return new ProviderError("auth", "clé refusée");
  if (error instanceof Anthropic.RateLimitError) return new ProviderError("rate", "limite de débit");
  if (error instanceof Anthropic.NotFoundError) return new ProviderError("config", "modèle inconnu");
  if (error instanceof Anthropic.BadRequestError) {
    // Le crédit épuisé n'a pas de classe à lui : c'est un 400 dont seul le message le dit
    // (« Your credit balance is too low to access the Anthropic API »).
    if (/credit balance is too low/i.test(error.message)) return new ProviderError("credit", "crédit épuisé");
    return new ProviderError("config", safeMessage(error.message));
  }
  if (error instanceof Anthropic.InternalServerError) return new ProviderError("server", `erreur ${error.status}`);
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError("network", "réseau");
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new ProviderError(status === 529 || status >= 500 ? "server" : "config", `erreur ${status}`);
  }
  return new ProviderError("network", "réseau");
}
