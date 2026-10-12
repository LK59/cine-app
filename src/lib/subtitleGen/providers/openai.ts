import { ProviderError, kindOfStatus, replyOf, safeMessage, type TranslationCall, type TranslationProvider, type TranslationReply } from "./types";

/**
 * OpenAI, par l'API Responses en `fetch` direct — pas de SDK pour un seul appel.
 * Documentation : https://developers.openai.com/api/docs/guides/reasoning (champ `reasoning`),
 * https://developers.openai.com/api/docs/guides/structured-outputs (`text.format` json_schema),
 * https://developers.openai.com/api/docs/models/gpt-6-luna (efforts acceptés : none … max).
 *
 * `reasoning.effort: "none"` pour gpt-6-luna, qui l'accepte (vérifié sur sa fiche le 12/10/2026) ;
 * d'autres modèles le refusent d'un 400 (GPT-6 Astra), ils reçoivent donc `low`.
 * `store: false` : rien du texte n'a à rester chez le fournisseur au-delà de la réponse.
 *
 * Pas de flux : la réponse d'un lot arrive d'un bloc, ses lignes sont écrites à la fin (le flux
 * n'est branché que chez Anthropic, le fournisseur par défaut).
 *
 * Cache : implicite chez OpenAI, sur les préfixes identiques d'au moins 1 024 jetons. Le préfixe
 * stable (consignes, glossaire, texte source) va donc dans `instructions`, le suffixe variable dans
 * `input` ; les jetons relus sont rendus dans `usage.input_tokens_details.cached_tokens`, compris
 * dans `input_tokens`.
 */
const URL = "https://api.openai.com/v1/responses";

interface ResponsesBody {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  error?: { code?: string; type?: string; message?: string } | null;
}

export function openaiProvider(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): TranslationProvider {
  return {
    name: "openai",
    model,
    async complete(call: TranslationCall): Promise<TranslationReply> {
      let res: Response;
      try {
        res = await fetchImpl(URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            instructions: [call.system, ...call.stable].join("\n\n"),
            input: call.user,
            max_output_tokens: call.maxOutputTokens,
            reasoning: { effort: /luna/.test(model) ? "none" : "low" },
            // Sans schéma (les lots), du texte libre en lignes `id|traduction`.
            ...(call.schema ? { text: { format: { type: "json_schema", name: call.schemaName, schema: call.schema, strict: true } } } : {}),
            store: false,
          }),
          signal: call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        });
      } catch {
        throw new ProviderError("network", "réseau");
      }
      const body = (await res.json().catch(() => null)) as ResponsesBody | null;
      if (!res.ok) {
        // Le crédit épuisé est un 429 lui aussi : seul son code le distingue d'une limite de débit.
        if (res.status === 429 && body?.error?.code === "insufficient_quota") throw new ProviderError("credit", "crédit épuisé");
        throw new ProviderError(kindOfStatus(res.status), `erreur ${res.status}${body?.error?.code ? ` (${safeMessage(body.error.code)})` : ""}`);
      }
      const cached = body?.usage?.input_tokens_details?.cached_tokens ?? 0;
      const usage = {
        inputTokens: Math.max(0, (body?.usage?.input_tokens ?? 0) - cached),
        cacheWriteTokens: 0,
        cacheReadTokens: cached,
        outputTokens: body?.usage?.output_tokens ?? 0,
      };
      const parts = (body?.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
      if (parts.some((p) => p.type === "refusal")) throw new ProviderError("refusal", "refus", usage);
      if (body?.status === "incomplete") {
        const reason = body.incomplete_details?.reason ?? "";
        throw new ProviderError(reason === "content_filter" ? "refusal" : "truncated", `réponse incomplète (${safeMessage(reason)})`, usage);
      }
      const text = parts.filter((p) => p.type === "output_text").map((p) => p.text ?? "").join("");
      return replyOf(call, text, usage);
    },
  };
}
