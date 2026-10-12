import { ProviderError, kindOfStatus, replyOf, safeMessage, type TranslationCall, type TranslationProvider, type TranslationReply } from "./types";

/**
 * Google Gemini, par `generateContent` en `fetch` direct.
 * Documentation : https://ai.google.dev/api/generate-content (GenerationConfig, usageMetadata,
 * FinishReason, promptFeedback.blockReason), https://ai.google.dev/gemini-api/docs/thinking
 * (niveaux de gemini-3.8-flash : low, medium, high — pas de « minimal » pour ce modèle).
 *
 * La clé part dans l'en-tête `x-goog-api-key`, jamais dans l'adresse : une URL finit dans des
 * journaux, un en-tête non. Les jetons de réflexion (`thoughtsTokenCount`) sont facturés comme la
 * sortie — ils y sont ajoutés.
 *
 * Pas de flux : la réponse d'un lot arrive d'un bloc, ses lignes sont écrites à la fin (le flux
 * n'est branché que chez Anthropic, le fournisseur par défaut).
 *
 * Cache : implicite sur les modèles Gemini 3 pour les préfixes identiques ; le préfixe stable va
 * dans `systemInstruction`, le suffixe dans le message. Les jetons relus
 * (`cachedContentTokenCount`) sont compris dans `promptTokenCount`.
 */
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GenerateBody {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { status?: string; message?: string; details?: { reason?: string }[] };
}

const REFUSALS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE"]);

export function googleProvider(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): TranslationProvider {
  return {
    name: "google",
    model,
    async complete(call: TranslationCall): Promise<TranslationReply> {
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [call.system, ...call.stable].map((text) => ({ text })) },
            contents: [{ role: "user", parts: [{ text: call.user }] }],
            generationConfig: {
              // Sans schéma (les lots), du texte libre en lignes `id|traduction`.
              ...(call.schema ? { responseMimeType: "application/json", responseJsonSchema: call.schema } : {}),
              maxOutputTokens: call.maxOutputTokens,
              thinkingConfig: { thinkingLevel: "low" },
            },
          }),
          signal: call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        });
      } catch {
        throw new ProviderError("network", "réseau");
      }
      const body = (await res.json().catch(() => null)) as GenerateBody | null;
      if (!res.ok) {
        // Une clé invalide répond 400 chez Google, avec la raison API_KEY_INVALID.
        if (body?.error?.details?.some((d) => d.reason === "API_KEY_INVALID")) throw new ProviderError("auth", "clé refusée");
        throw new ProviderError(kindOfStatus(res.status), `erreur ${res.status}${body?.error?.status ? ` (${safeMessage(body.error.status)})` : ""}`);
      }
      const meta = body?.usageMetadata;
      const cached = meta?.cachedContentTokenCount ?? 0;
      const usage = {
        inputTokens: Math.max(0, (meta?.promptTokenCount ?? 0) - cached),
        cacheWriteTokens: 0,
        cacheReadTokens: cached,
        outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
      };
      if (body?.promptFeedback?.blockReason) throw new ProviderError("refusal", `bloqué (${safeMessage(body.promptFeedback.blockReason)})`, usage);
      const candidate = body?.candidates?.[0];
      const finish = candidate?.finishReason ?? "";
      if (REFUSALS.has(finish)) throw new ProviderError("refusal", `refus (${finish})`, usage);
      if (finish === "MAX_TOKENS") throw new ProviderError("truncated", "réponse coupée", usage);
      const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
      return replyOf(call, text, usage);
    },
  };
}
