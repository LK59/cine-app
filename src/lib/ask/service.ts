// « Poser une question » (DECISIONS.md §139) — Jellyfin, les dialogues, le modèle.
//
// Ce qui est vu se lit chez Jellyfin **sous l'identité du compte** (`/Users/{compte}/Items/…`) : ses tags
// bloqués et son contrôle parental s'appliquent, un titre qu'il ne voit pas répond « indisponible », comme
// s'il n'existait pas. Les dialogues viennent de la même source que « Précédemment » (`cuesOf`, §137) —
// la piste texte de la langue du compte, sinon l'anglais —, gardés une heure en mémoire par élément et par
// langue : lire les sous-titres intégrés prend 12 à 45 s à Jellyfin (mesuré le 08/11/2026). L'ouverture du
// panneau les demande d'avance (`prepareAskContext`) ; une question qui arrive avant n'attend que
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
  /** La date de sortie (film) ou de première diffusion (épisode) — tirée de TMDB par Jellyfin (10.27.2). */
  PremiereDate?: string;
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

// ── Le contexte préparé à l'ouverture du lecteur (10.27.2) ───────────────────────────────────────
// Quand un film ou un épisode s'ouvre au lecteur (option ouverte à la séance), la page demande
// `GET /api/cinema/ask/{id}` : l'élément, la série et la liste de ses épisodes (résumés, vus ou non) sont lus
// sous l'identité du compte et gardés ici, et les répliques demandées d'avance (`cuesKept`). Une question ou
// « Jusqu'ici » ensuite ne fait plus que couper à sa position (`ctx: "prêt"` au journal). Borné (quelques
// éléments, les plus récents), quinze minutes : ce qui a été vu change lentement pendant un film, et une
// préparation plus vieille est relue (`ctx: "construit"`). Sur `globalThis`, comme les répliques.
const PREPARED_KEY = Symbol.for("cine-app.askPrepared");
type Prepared = { at: number; item: FullItem; series: FullItem | null; episodes: EpisodeWithStreams[] | null };
const preparedShared = globalThis as typeof globalThis & { [PREPARED_KEY]?: Map<string, Prepared> };
const prepared = (preparedShared[PREPARED_KEY] ??= new Map());
export const PREPARED_TTL_MS = 15 * 60_000;
export const PREPARED_KEEP = 8;

function keepPrepared(key: string, value: Prepared): void {
  prepared.delete(key);
  prepared.set(key, value);
  while (prepared.size > PREPARED_KEEP) prepared.delete(prepared.keys().next().value as string);
}

/** L'élément, sa série et ses épisodes pour ce compte : gardés s'ils ont moins de quinze minutes, sinon relus. */
async function contextParts(jfId: string, itemId: string, now = Date.now()): Promise<{ parts: Prepared | null; ready: boolean }> {
  const key = `${jfId}:${itemId}`;
  const kept = prepared.get(key);
  if (kept && now - kept.at < PREPARED_TTL_MS) return { parts: kept, ready: true };
  const item = await itemFor(jfId, itemId);
  if (!item) return { parts: null, ready: false };
  let series: FullItem | null = null;
  let episodes: EpisodeWithStreams[] | null = null;
  const seriesId = item.Type === "Series" ? item.Id : item.Type === "Episode" ? item.SeriesId : null;
  if (seriesId) {
    [series, episodes] = await Promise.all([item.Type === "Series" ? Promise.resolve(item) : itemFor(jfId, seriesId), episodesOf(jfId, seriesId)]);
  }
  const parts = { at: now, item, series, episodes };
  keepPrepared(key, parts);
  return { parts, ready: false };
}

/**
 * Préparer ce que le compte regarde (10.27.2) : appelé à l'ouverture du lecteur et du panneau, sans rien
 * attendre. Une erreur ici ne regarde personne : la demande suivante construira son contexte elle-même.
 */
export async function prepareAskContext(jfId: string, itemId: string, locale: Locale): Promise<void> {
  try {
    const { parts } = await contextParts(jfId, itemId);
    if (!parts) return;
    const { item, episodes } = parts;
    if (item.Type === "Movie" || item.Type === "Episode") void cuesKept(item, locale);
    else if (item.Type === "Series") {
      const current = (episodes ?? []).find((e) => !e.UserData?.Played && positionOf(e) > 0);
      if (current) void cuesKept(current, locale);
    }
  } catch (err) {
    logError("ask/warm", err);
  }
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
  | {
      status: "ok";
      input: AskContextInput;
      dialogueLate: boolean;
      /** `prêt` : l'élément et ses épisodes venaient de la préparation (10.27.2) ; `construit` : lus pour cette demande. */
      ctx: "prêt" | "construit";
    }
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
  const { parts, ready } = await contextParts(jfId, itemId);
  if (!parts) return { status: "indisponible" };
  const item = parts.item;
  const ctx = ready ? ("prêt" as const) : ("construit" as const);

  if (item.Type === "Movie") {
    const watchedAll = item.UserData?.Played === true;
    const positionS = where === "lecteur" ? playerPositionS : positionOf(item) || null;
    const wantsCues = watchedAll || (positionS ?? 0) > 0;
    const cues = wantsCues ? await cuesWithin(item, locale, waitMs) : [];
    return {
      status: "ok",
      dialogueLate: cues === null,
      ctx,
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
        airDate: item.PremiereDate ?? null,
      },
    };
  }

  const seriesId = item.Type === "Series" ? item.Id : item.Type === "Episode" ? item.SeriesId : null;
  if (!seriesId) return { status: "indisponible" };
  const series = parts.series;
  const episodes = parts.episodes ?? [];
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
    ctx,
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
      // L'épisode joué est l'élément entier (sa date y est toujours) ; depuis la fiche, celui de la liste.
      airDate: (item.Type === "Episode" ? item.PremiereDate : (current as FullItem | null)?.PremiereDate) ?? null,
    },
  };
}

// ── Le modèle ─────────────────────────────────────────────────────────────────────────────────────

export interface AskModelRun {
  /** Le texte, morceau par morceau. */
  deltas: AsyncIterable<string>;
  /**
   * La fin : jetons, et pourquoi le modèle s'est arrêté. `cacheWrite` / `cacheRead` (10.27.2) : les jetons
   * du préfixe écrits dans le cache de prompts d'Anthropic, ou relus de lui.
   */
  done: Promise<{ inTokens: number; outTokens: number; stop: string | null; cacheWrite?: number; cacheRead?: number }>;
}

/**
 * Le modèle, remplaçable dans les tests — aucun appel réseau réel n'y part.
 *
 * `prefixEnd` (10.27.2) : `message.slice(0, prefixEnd)` est la partie partagée — les sources (résumés,
 * répliques jusqu'à la coupe) et où en est le spectateur —, envoyée comme un premier bloc marqué
 * `cache_control: { type: "ephemeral" }` ; le reste (la personne, la question) vient après, dans un second
 * bloc. Avec la consigne (`system`, fixe par langue) devant, c'est le préfixe que le cache de prompts
 * d'Anthropic garde cinq minutes : la deuxième personne d'une même scène, ou la question suivante, relit
 * ces milliers de jetons au dixième du prix et plus vite. Le message entier reste `message` — c'est lui que
 * l'empreinte de « Jusqu'ici » (`sofarKey`) prend, jamais le découpage.
 */
export type AskModel = (req: {
  system: string;
  message: string;
  prefixEnd?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** La fonction qui paie (§140) : la ligne de dépense du jour la range sous elle (Activité). */
  feature?: "askTitle" | "askPerson" | "sofar";
}) => AskModelRun;

/**
 * Les plafonds de sortie (10.27.2), réflexion comprise — mesurés dans `recherche.log` le 09/11/2026 :
 * « Jusqu'ici » jusqu'à 1 730 jetons, une question jusqu'à 1 151. Assez haut pour ne jamais couper une
 * réponse ordinaire ; une réponse qui l'atteint (`stop_reason: "max_tokens"`) est une panne dite proprement
 * — la ligne discrète de « Jusqu'ici », « Réessayer » pour une question —, jamais une phrase coupée.
 */
export const ASK_MAX_OUTPUT_TOKENS = 2000;
export const SOFAR_MAX_OUTPUT_TOKENS = 2500;

/** Le contenu du message : en deux blocs, le premier marqué pour le cache, quand un préfixe est donné. */
export function askContent(message: string, prefixEnd?: number): string | Anthropic.TextBlockParam[] {
  if (!prefixEnd || prefixEnd <= 0 || prefixEnd >= message.length) return message;
  return [
    { type: "text", text: message.slice(0, prefixEnd), cache_control: { type: "ephemeral" } },
    { type: "text", text: message.slice(prefixEnd) },
  ];
}

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
 *
 * Le préfixe partagé (`prefixEnd`, 10.27.2) va dans `stable`, la personne ou la question dans `user` :
 * chez ces deux fournisseurs, le cache est implicite sur les préfixes identiques — le même découpage que
 * le point de cache explicite d'Anthropic, relu au même prix réduit. Les mêmes plafonds de sortie.
 */
function askOtherProvider({ system, message, prefixEnd, maxTokens, signal, feature = "askTitle" }: Parameters<AskModel>[0]): AskModelRun {
  const timeout = AbortSignal.timeout(MODEL_WHOLE_MS);
  const split = !!prefixEnd && prefixEnd > 0 && prefixEnd < message.length;
  const reply = featureComplete(
    {
      system,
      stable: split ? [message.slice(0, prefixEnd)] : [],
      cache: false,
      user: split ? message.slice(prefixEnd) : message,
      schemaName: "answer",
      maxOutputTokens: maxTokens ?? ASK_MAX_OUTPUT_TOKENS,
      effort: "low",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    },
    feature
  ).then(
    (r) => ({ text: r.text, inTokens: r.usage.inputTokens + r.usage.cacheReadTokens, outTokens: r.usage.outputTokens, stop: "end_turn" as string | null, cacheRead: r.usage.cacheReadTokens }),
    (error: unknown) => {
      if (error instanceof ProviderError && error.kind === "refusal") return { text: "", inTokens: error.usage?.inputTokens ?? 0, outTokens: error.usage?.outputTokens ?? 0, stop: "refusal" as string | null, cacheRead: 0 };
      if (error instanceof ProviderError && error.kind === "truncated") return { text: "", inTokens: error.usage?.inputTokens ?? 0, outTokens: error.usage?.outputTokens ?? 0, stop: "max_tokens" as string | null, cacheRead: 0 };
      if (timeout.aborted && !signal?.aborted) throw new AskModelTimeout();
      if (error instanceof ProviderError && error.kind === "rate") throw Object.assign(new Error(error.message), { status: 429 });
      throw error;
    }
  );
  async function* deltas() {
    const r = await reply;
    if (r.text) yield r.text;
  }
  return { deltas: deltas(), done: reply.then(({ inTokens, outTokens, stop, cacheRead }) => ({ inTokens, outTokens, stop, cacheWrite: 0, cacheRead })) };
}

const askModel: AskModel = (req) => {
  if (featureSettings().provider !== "anthropic") return askOtherProvider(req);
  const { system, message, prefixEnd, maxTokens, signal, feature = "askTitle" } = req;
  const client = new Anthropic({ apiKey: config.subtitleGen.apiKey.trim(), maxRetries: 0, timeout: MODEL_IDLE_MS });
  const stream = client.messages.stream(
    {
      model: ASK_MODEL,
      // La réflexion compte dans `max_tokens` ; la réponse, elle, fait quatre phrases (plafonds mesurés plus haut).
      max_tokens: maxTokens ?? ASK_MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: askContent(message, prefixEnd) }],
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
        // Compté dans le plafond mensuel commun (§140) — écriture et relecture du cache comprises, chacune à
        // son prix (`anthropicUsage`).
        recordAiSpend(anthropicUsage(m.usage), featureSettings().price, feature);
        return {
          inTokens: m.usage.input_tokens,
          outTokens: m.usage.output_tokens,
          stop: m.stop_reason ?? null,
          cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
          cacheRead: m.usage.cache_read_input_tokens ?? 0,
        };
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
  prepared.clear();
}
