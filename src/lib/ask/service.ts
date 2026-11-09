// « Poser une question » (DECISIONS.md §139) — Jellyfin, les dialogues, le modèle.
//
// Ce qui est vu se lit chez Jellyfin **sous l'identité du compte** (`/Users/{compte}/Items/…`) : ses tags
// bloqués et son contrôle parental s'appliquent, un titre qu'il ne voit pas répond « indisponible », comme
// s'il n'existait pas. Les dialogues viennent de la même source que « Précédemment » (`cuesOf`, §137) —
// la piste texte de la langue du compte, sinon l'anglais —, gardés une heure en mémoire par élément et par
// langue : lire les sous-titres intégrés prend 12 à 45 s à Jellyfin (mesuré le 08/11/2026). L'ouverture du
// panneau les demande d'avance (`warmDialogues`) ; une question qui arrive avant n'attend que
// `DIALOGUE_WAIT_MS`, puis répond sans eux — la lecture continue et sert à la question suivante.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import type { JellyfinItem } from "@/lib/clients/jellyfin";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { upstreamSignal } from "@/lib/http";
import { DEFAULT_MODELS } from "@/lib/subtitleGen/pricing";
import { ProviderError } from "@/lib/subtitleGen/providers";
import { anthropicUsage, featureComplete, featureProviderReady, featureSettings, recordAiSpend } from "@/lib/aiFeatures";
import { cuesOf, episodesOf, type EpisodeWithStreams } from "@/lib/recap/service";
import type { Cue } from "@/lib/recap/core";
import type { Locale } from "@/lib/i18n";
import { logError } from "@/lib/logger";
import { audienceAllows, type Audience } from "@/lib/featureAudience";
import type { AskContextInput, AskEpisode, AskWhere } from "@/lib/ask/core";

export const ASK_MODEL = DEFAULT_MODELS.anthropic;
/** Une question n'attend pas plus les dialogues : au-delà, la réponse part sans eux. */
export const DIALOGUE_WAIT_MS = 8000;
const DIALOGUE_TTL_MS = 60 * 60 * 1000;
const DIALOGUE_KEEP = 24;
/**
 * Le modèle a 20 s pour répondre, puis 20 s au plus entre deux événements du flux (10.27, consigne du
 * propriétaire) : au-delà, la réponse est une panne dite proprement — jamais un panneau qui attend.
 */
export const MODEL_IDLE_MS = 20_000;

export function askAvailable(): boolean {
  // Lu par la configuration publique à chaque ouverture : une configuration partielle vaut « coupé ».
  // Les trois fournisseurs depuis le 09/11/2026 (§140). Le plafond mensuel n'y entre pas : atteint, la
  // question reçoit une ligne d'erreur dite (`budget`), le bouton ne disparaît pas sans explication.
  return askAudience() !== "off" && featureProviderReady();
}

/** Le modèle qui répond aux questions et écrit « Jusqu'ici » — dans la clé de leurs textes gardés. */
export function askModelName(): string {
  try {
    return featureSettings().model;
  } catch {
    return ASK_MODEL;
  }
}

/** À qui l'option est ouverte ; une configuration sans `audience` (un double de test) se lit par `enabled`. */
function askAudience(): Audience {
  const ask = config.ask as { audience?: Audience; enabled?: boolean } | undefined;
  return ask?.audience ?? (ask?.enabled === true ? "tous" : "off");
}

/**
 * L'option est-elle ouverte à **cette** session (`off` / `admins` / `tous`, `featureAudience.ts`) — la
 * porte, que chaque route appelle ; l'écran ne fait que cacher ce qu'elle refuse.
 */
export function askAvailableFor(session: { role?: string | null } | null | undefined): boolean {
  return askAvailable() && audienceAllows(askAudience(), session);
}

type FullItem = EpisodeWithStreams & {
  Taglines?: string[];
  People?: { Name?: string; Role?: string; Type?: string }[];
};

/** L'élément vu par ce compte, ou `null` s'il ne le voit pas (tags bloqués, bibliothèque, contrôle parental). */
async function itemFor(jfId: string, itemId: string): Promise<FullItem | null> {
  const url = `${config.jellyfin.url}/Users/${jellyfinIdSegment(jfId)}/Items/${jellyfinIdSegment(itemId)}`;
  const res = await jellyfinFetch(url, { headers: jellyfinAuthHeaders(config.jellyfin.apiKey), signal: upstreamSignal(10_000) });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Jellyfin ${res.status} sur l'élément`);
  return (await res.json()) as FullItem;
}

// ── Les dialogues, gardés en mémoire ─────────────────────────────────────────────────────────────
// Sur `globalThis` : la route de la question et celle de l'ouverture du panneau sont deux entrées du
// build, et chacune aurait eu sa copie du module (la leçon de `server-cache.ts`).
const CUES_KEY = Symbol.for("cine-app.askCues");
type CueEntry = { at: number; cues: Promise<Cue[]> };
const shared = globalThis as typeof globalThis & { [CUES_KEY]?: Map<string, CueEntry> };
const cueCache = (shared[CUES_KEY] ??= new Map());

function cuesKept(item: EpisodeWithStreams, locale: Locale, now = Date.now()): Promise<Cue[]> {
  const key = `${item.Id}:${locale}`;
  const known = cueCache.get(key);
  if (known && now - known.at < DIALOGUE_TTL_MS) return known.cues;
  // Une piste illisible ou une panne : pas de dialogues, et on réessaiera à la prochaine heure.
  const cues = cuesOf(item, locale).catch((err) => {
    logError("ask/dialogues", err);
    return [] as Cue[];
  });
  cueCache.delete(key);
  cueCache.set(key, { at: now, cues });
  while (cueCache.size > DIALOGUE_KEEP) cueCache.delete(cueCache.keys().next().value as string);
  return cues;
}

/** Les dialogues, sans attendre plus de `waitMs` : `null` s'ils ne sont pas encore là. */
async function cuesWithin(item: EpisodeWithStreams, locale: Locale, waitMs: number): Promise<Cue[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([cuesKept(item, locale), late]);
  } finally {
    clearTimeout(timer);
  }
}

const code = (e: Pick<JellyfinItem, "ParentIndexNumber" | "IndexNumber">) =>
  `S${String(e.ParentIndexNumber ?? 0).padStart(2, "0")}E${String(e.IndexNumber ?? 0).padStart(2, "0")}`;
const positionOf = (e: JellyfinItem) => Math.floor((e.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000);
const castOf = (item: FullItem) =>
  (item.People ?? []).filter((p) => p.Type === "Actor" && p.Name).map((p) => ({ name: p.Name!, role: p.Role ?? null }));

export type AskContext =
  | { status: "ok"; input: AskContextInput; dialogueLate: boolean }
  | { status: "indisponible" };

/**
 * Ce que ce compte a vu de l'élément, prêt pour `askSources` :
 * - un **film** : synopsis, accroche, distribution ; les dialogues jusqu'à la position du lecteur (au
 *   lecteur) ou jusqu'à la reprise gardée par Jellyfin (sur la fiche) ; tout, film terminé ;
 * - un **épisode** (au lecteur) : la série, ses épisodes, celui-ci en cours à la position du lecteur ;
 * - une **série** (sur la fiche) : l'épisode commencé s'il y en a un, à sa reprise ; sinon aucun dialogue.
 * Les résumés partent pour les seuls épisodes terminés — le tri est dans `askSources`.
 */
export async function gatherAskContext(
  jfId: string,
  itemId: string,
  where: AskWhere,
  playerPositionS: number | null,
  locale: Locale,
  waitMs = DIALOGUE_WAIT_MS
): Promise<AskContext> {
  const item = await itemFor(jfId, itemId);
  if (!item) return { status: "indisponible" };

  if (item.Type === "Movie") {
    const watchedAll = item.UserData?.Played === true;
    const positionS = where === "lecteur" ? playerPositionS : positionOf(item) || null;
    const wantsCues = watchedAll || (positionS ?? 0) > 0;
    const cues = wantsCues ? await cuesWithin(item, locale, waitMs) : [];
    return {
      status: "ok",
      dialogueLate: cues === null,
      input: {
        kind: "movie",
        title: item.Name,
        year: item.ProductionYear ?? null,
        overview: item.Overview ?? null,
        tagline: item.Taglines?.[0] ?? null,
        cast: castOf(item),
        watchedAll,
        positionS,
        cues: cues ?? [],
      },
    };
  }

  const seriesId = item.Type === "Series" ? item.Id : item.Type === "Episode" ? item.SeriesId : null;
  if (!seriesId) return { status: "indisponible" };
  const [series, episodes] = await Promise.all([item.Type === "Series" ? Promise.resolve(item) : itemFor(jfId, seriesId), episodesOf(jfId, seriesId)]);
  if (!series) return { status: "indisponible" };
  const watchedAll = series.UserData?.Played === true && episodes.length > 0 && episodes.every((e) => e.UserData?.Played);

  // L'épisode en cours : celui que le lecteur joue ; depuis la fiche, celui qui a une reprise.
  let current: EpisodeWithStreams | null = null;
  let positionS: number | null = null;
  if (item.Type === "Episode") {
    current = episodes.find((e) => e.Id === item.Id) ?? item;
    positionS = where === "lecteur" ? playerPositionS : positionOf(item) || null;
  } else {
    current = episodes.find((e) => !e.UserData?.Played && positionOf(e) > 0) ?? null;
    positionS = current ? positionOf(current) : null;
  }
  // Un épisode revu (déjà terminé) n'ouvre pas pour autant ses dialogues au-delà de la position : seul
  // la série entière vue le fait (`seenCues`).
  const wantsCues = !!current && (watchedAll || (positionS ?? 0) > 0);
  const cues = wantsCues && current ? await cuesWithin(current, locale, waitMs) : [];
  const list: AskEpisode[] = episodes.map((e) => ({ code: code(e), title: e.Name, overview: e.Overview ?? "", played: e.UserData?.Played === true }));
  return {
    status: "ok",
    dialogueLate: cues === null,
    input: {
      kind: "series",
      title: series.Name,
      year: series.ProductionYear ?? null,
      overview: series.Overview ?? null,
      tagline: (series as FullItem).Taglines?.[0] ?? null,
      cast: castOf(series as FullItem),
      watchedAll,
      episodes: list,
      current: current ? { code: code(current), title: current.Name } : null,
      positionS,
      cues: cues ?? [],
    },
  };
}

/**
 * Demander d'avance les dialogues de ce que le compte regarde — à l'ouverture du panneau, sans rien
 * attendre. Une erreur ici ne regarde personne : la question suivante répondra sans dialogues.
 */
export async function warmDialogues(jfId: string, itemId: string, locale: Locale): Promise<void> {
  try {
    const item = await itemFor(jfId, itemId);
    if (!item) return;
    if (item.Type === "Movie" || item.Type === "Episode") void cuesKept(item, locale);
    else if (item.Type === "Series") {
      const current = (await episodesOf(jfId, item.Id)).find((e) => !e.UserData?.Played && positionOf(e) > 0);
      if (current) void cuesKept(current, locale);
    }
  } catch (err) {
    logError("ask/warm", err);
  }
}

// ── Le modèle ─────────────────────────────────────────────────────────────────────────────────────

export interface AskModelRun {
  /** Le texte, morceau par morceau. */
  deltas: AsyncIterable<string>;
  /** La fin : jetons, et pourquoi le modèle s'est arrêté. */
  done: Promise<{ inTokens: number; outTokens: number; stop: string | null }>;
}

/** Le modèle, remplaçable dans les tests — aucun appel réseau réel n'y part. */
export type AskModel = (req: { system: string; message: string; signal?: AbortSignal }) => AskModelRun;

/** Une panne du modèle qui n'est pas une réponse HTTP : le délai dépassé, un flux coupé. */
export class AskModelTimeout extends Error {
  constructor() {
    super(`le modèle n'a rien envoyé pendant ${MODEL_IDLE_MS / 1000} s`);
    this.name = "AskModelTimeout";
  }
}

/**
 * Sans flux, la réponse entière doit arriver dans ce délai — une seule attente, pas de chien de garde
 * réarmé par les événements (OpenAI et Gemini, §140).
 */
export const MODEL_WHOLE_MS = 30_000;

/**
 * OpenAI ou Gemini (§140) : un seul appel, sans flux — la réponse arrive d'un bloc, puis passe par le
 * même `AnswerGate` (noms, mots interdits) que chez Anthropic, phrase par phrase. Réflexion basse comme
 * chez Anthropic. Un refus devient `stop: "refusal"` (la panne dite) ; une limite de débit garde son 429.
 */
function askOtherProvider({ system, message, signal }: { system: string; message: string; signal?: AbortSignal }): AskModelRun {
  const timeout = AbortSignal.timeout(MODEL_WHOLE_MS);
  const reply = featureComplete(
    { system, stable: [], cache: false, user: message, schemaName: "answer", maxOutputTokens: 4000, effort: "low", signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    "askTitle"
  ).then(
    (r) => ({ text: r.text, inTokens: r.usage.inputTokens + r.usage.cacheReadTokens, outTokens: r.usage.outputTokens, stop: "end_turn" as string | null }),
    (error: unknown) => {
      if (error instanceof ProviderError && error.kind === "refusal") return { text: "", inTokens: error.usage?.inputTokens ?? 0, outTokens: error.usage?.outputTokens ?? 0, stop: "refusal" as string | null };
      if (error instanceof ProviderError && error.kind === "truncated") return { text: "", inTokens: error.usage?.inputTokens ?? 0, outTokens: error.usage?.outputTokens ?? 0, stop: "max_tokens" as string | null };
      if (timeout.aborted && !signal?.aborted) throw new AskModelTimeout();
      if (error instanceof ProviderError && error.kind === "rate") throw Object.assign(new Error(error.message), { status: 429 });
      throw error;
    }
  );
  async function* deltas() {
    const r = await reply;
    if (r.text) yield r.text;
  }
  return { deltas: deltas(), done: reply.then(({ inTokens, outTokens, stop }) => ({ inTokens, outTokens, stop })) };
}

const askModel: AskModel = (req) => {
  if (featureSettings().provider !== "anthropic") return askOtherProvider(req);
  const { system, message, signal } = req;
  const client = new Anthropic({ apiKey: config.subtitleGen.apiKey.trim(), maxRetries: 0, timeout: MODEL_IDLE_MS });
  const stream = client.messages.stream(
    {
      model: ASK_MODEL,
      // La réflexion compte dans `max_tokens` ; la réponse, elle, fait quatre phrases.
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: message }],
      // Réflexion adaptative, effort bas : la réponse se lit pendant qu'on attend, film en pause. Le banc
      // de §137 a montré que sans réflexion Haiku prête des actes au mauvais personnage ; l'effort bas en
      // garde une part sans faire attendre (mesures au §139).
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    },
    { signal }
  );
  // Le chien de garde : chaque événement du flux (réflexion comprise) le réarme ; vingt secondes de
  // silence, et le flux est coupé — la panne remonte comme `AskModelTimeout`.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      stream.abort();
    }, MODEL_IDLE_MS);
  };
  arm();
  const fail = (err: unknown) => (timedOut ? new AskModelTimeout() : err);
  async function* deltas() {
    try {
      for await (const event of stream) {
        arm();
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
      }
    } catch (err) {
      throw fail(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    deltas: deltas(),
    done: stream.finalMessage().then(
      (m) => {
        // Compté dans le plafond mensuel commun (§140).
        recordAiSpend(anthropicUsage(m.usage), featureSettings().price, "askTitle");
        return { inTokens: m.usage.input_tokens, outTokens: m.usage.output_tokens, stop: m.stop_reason ?? null };
      },
      (err: unknown) => {
        throw fail(err);
      }
    ),
  };
};

let model: AskModel = askModel;
export function currentAskModel(): AskModel {
  return model;
}
export function setAskModelForTests(fn: AskModel | null): void {
  model = fn ?? askModel;
}
export function resetAskCachesForTests(): void {
  cueCache.clear();
}
