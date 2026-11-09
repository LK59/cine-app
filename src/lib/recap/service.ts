// « Précédemment » (DECISIONS.md §137) — Jellyfin, le modèle, la base, et la tâche de fond.
//
// Rien n'est préparé à l'ouverture d'une fiche : lire les sous-titres d'un épisode prend 12 à 45 s à
// Jellyfin quand ils sont dans le fichier (mesuré le 08/11/2026). La tâche de fond prépare donc, pour
// chaque compte du foyer — qu'il ouvre l'application ou non —, ses séries en cours laissées depuis dix
// minutes ; la fiche lit ce qui est prêt, en une requête pour toutes (`readyRecapsFor`), ou garde son
// synopsis.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { recapDb, sessionDb, userPrefsDb, type ReadyRecap } from "@/lib/db";
import { jellyfin, type JellyfinItem } from "@/lib/clients/jellyfin";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { upstreamSignal } from "@/lib/http";
import { DEFAULT_MODELS } from "@/lib/subtitleGen/pricing";
import { ProviderError } from "@/lib/subtitleGen/providers";
import { aiBudgetReached, anthropicTimed, anthropicUsage, featureComplete, featureProviderReady, featureSettings, recordAiSpend } from "@/lib/aiFeatures";
import { logRecap } from "@/lib/eventLogs";
import { logError } from "@/lib/logger";
import { fetchJson } from "@/lib/http";
import { taskLog } from "@/lib/taskLog";
import { LOCALES, type Locale } from "@/lib/i18n";
import {
  judgeRecap,
  parseSrt,
  pickSubtitleStream,
  recapKey,
  recapSources,
  recapStep,
  recapSystem,
  RECAP_IDLE_MS,
  RECAP_SCHEMA,
  RECAP_STARTED_S,
  type Cue,
  type SubtitleStream,
} from "@/lib/recap/core";

export const RECAP_MODEL = DEFAULT_MODELS.anthropic;
/** Les séries « À suivre » regardées par compte : les plus récentes d'abord, comme Jellyfin les rend. */
const SERIES_PER_ACCOUNT = 12;
/** Une série laissée depuis plus longtemps n'est plus « en cours » (`NextUpDateCutoff`). */
const SERIES_RECENT_MS = 30 * 24 * 60 * 60 * 1000;
/** Au plus par passage : un compte qui revient après un mois ne fait pas trente appels d'un coup. */
const PER_PASS = 12;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
/** Réactif (Louis, 08/11/2026) : dix minutes après l'arrêt, le texte est prêt dans les cinq qui suivent. */
const INTERVAL_MS = 5 * 60 * 1000;
const MODEL_TIMEOUT_MS = 90_000;
const SUBTITLE_TIMEOUT_MS = 90_000;

export function recapAvailable(): boolean {
  // Lu par la configuration publique à chaque ouverture : une configuration partielle (les doubles des
  // tests, une installation qui n'a jamais vu la clé) vaut « coupé », jamais une erreur. Les trois
  // fournisseurs depuis le 09/11/2026 (§140). Le plafond mensuel n'y entre pas : atteint, les textes
  // déjà prêts restent lisibles, seule la préparation s'arrête (`runRecapPass`).
  return config.recap?.enabled === true && featureProviderReady();
}

export function recapLocale(value: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : "fr";
}

/** La langue du compte, gardée côté serveur (`user_preferences.lang`) — la même pour la route et la tâche. */
export function accountLocale(jfId: string): Locale {
  return recapLocale(userPrefsDb.getLang(jfId, config.app.language));
}

const code = (item: Pick<JellyfinItem, "ParentIndexNumber" | "IndexNumber">) =>
  `S${String(item.ParentIndexNumber ?? 0).padStart(2, "0")}E${String(item.IndexNumber ?? 0).padStart(2, "0")}`;
const positionOf = (item: JellyfinItem) => Math.floor((item.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000);

/**
 * Où en est un compte, série par série : l'épisode que Jellyfin propose ensuite (l'épisode commencé,
 * sinon le suivant du dernier vu) et la position dedans. Lu avec l'identifiant du compte : ses tags
 * bloqués s'appliquent, une série qui lui est cachée n'y est pas.
 */
async function positionsOf(jfId: string, now = Date.now()): Promise<{ seriesId: string; series: string; episode: JellyfinItem; positionS: number }[]> {
  const cutoff = new Date(now - SERIES_RECENT_MS).toISOString();
  const { Items: items } = await fetchJson<{ Items: JellyfinItem[] }>(
    `${config.jellyfin.url}/Shows/NextUp?UserId=${jellyfinIdSegment(jfId)}&Limit=${SERIES_PER_ACCOUNT}&NextUpDateCutoff=${encodeURIComponent(cutoff)}&Fields=UserData,SeriesName,SeriesId,IndexNumber,ParentIndexNumber`,
    { headers: jellyfinAuthHeaders(config.jellyfin.apiKey) }
  );
  return items.filter((e) => e.SeriesId).map((e) => ({ seriesId: e.SeriesId!, series: e.SeriesName ?? "", episode: e, positionS: positionOf(e) }));
}

export interface RecapForSheet {
  text: string;
  /** Depuis combien de minutes la série n'a pas été regardée — pour le journal d'usage. */
  idleMin: number | null;
  /** L'épisode où le compte en est (« S02E05 ») — le texte vaut pour cet endroit-là. */
  episode: string;
  /** `ia` : écrit par le modèle ; `officiel` : le résumé Jellyfin de l'épisode `about`, tel quel. */
  source: "ia" | "officiel";
  about: string | null;
}

/**
 * Quand le compte a regardé chaque série pour la dernière fois — une requête pour toutes : ses
 * épisodes les plus récemment lus, commencés ou finis.
 */
async function lastPlayedBySeries(jfId: string): Promise<Map<string, number>> {
  const { Items: items } = await fetchJson<{ Items: JellyfinItem[] }>(
    `${config.jellyfin.url}/Users/${jellyfinIdSegment(jfId)}/Items?IncludeItemTypes=Episode&Recursive=true&SortBy=DatePlayed&SortOrder=Descending&Limit=200&Fields=UserData,SeriesId`,
    { headers: jellyfinAuthHeaders(config.jellyfin.apiKey) }
  );
  const out = new Map<string, number>();
  for (const e of items) {
    const at = Date.parse(e.UserData?.LastPlayedDate ?? "");
    if (e.SeriesId && at && at > (out.get(e.SeriesId) ?? 0)) out.set(e.SeriesId, at);
  }
  return out;
}

/**
 * Les « Précédemment » prêts pour ce compte, par série — ce que la fiche lit. Rien s'il l'a coupé, et
 * rien pour une série regardée il y a moins de trois heures : un texte déjà prêt resterait sinon
 * affiché après une reprise de cinq minutes, tant que la tranche ne change pas.
 */
export async function readyRecapsFor(jfId: string, now = Date.now()): Promise<Record<string, RecapForSheet>> {
  if (!userPrefsDb.getShowRecap(jfId)) return {};
  const locale = accountLocale(jfId);
  const [states, lastPlayed] = await Promise.all([positionsOf(jfId, now), lastPlayedBySeries(jfId)]);
  const keys = states.map((s) => recapKey(s.episode.Id, s.positionS, locale));
  const ready = recapDb.readyAmong(keys);
  const out: Record<string, RecapForSheet> = {};
  states.forEach((s, i) => {
    const r: ReadyRecap | undefined = ready.get(keys[i]);
    const at = lastPlayed.get(s.seriesId);
    if (!r || (at && now - at < RECAP_IDLE_MS)) return;
    out[s.seriesId] = { text: r.text, episode: code(s.episode), source: r.status === "officiel" ? "officiel" : "ia", about: r.about, idleMin: at ? Math.round((now - at) / 60_000) : null };
  });
  return out;
}

export type EpisodeWithStreams = JellyfinItem & { MediaStreams?: SubtitleStream[]; MediaSources?: { Id: string }[] };

/** Les épisodes d'une série vus par ce compte, dans l'ordre — lus aussi par « Poser une question » (§139). */
export async function episodesOf(jfId: string, seriesId: string): Promise<EpisodeWithStreams[]> {
  const url = `${config.jellyfin.url}/Shows/${jellyfinIdSegment(seriesId)}/Episodes?userId=${jellyfinIdSegment(jfId)}&Fields=Overview,UserData,MediaStreams,MediaSources`;
  const res = await jellyfinFetch(url, { headers: jellyfinAuthHeaders(config.jellyfin.apiKey), signal: upstreamSignal(15_000) });
  if (!res.ok) throw new Error(`Jellyfin ${res.status} sur les épisodes`);
  const body = (await res.json()) as { Items?: EpisodeWithStreams[] };
  // Les épisodes spéciaux (saison 0) ne sont pas dans le fil de l'histoire.
  return (body.Items ?? []).filter((e) => (e.ParentIndexNumber ?? 0) > 0);
}

/** Les répliques d'un élément (épisode ou film) — la source des dialogues de §137, reprise par §139. */
export async function cuesOf(episode: EpisodeWithStreams, locale: Locale): Promise<Cue[]> {
  const stream = pickSubtitleStream(episode.MediaStreams ?? [], locale);
  const source = episode.MediaSources?.[0]?.Id;
  if (!stream || !source) return [];
  const url = `${config.jellyfin.url}/Videos/${jellyfinIdSegment(episode.Id)}/${jellyfinIdSegment(source)}/Subtitles/${stream.Index}/0/Stream.srt`;
  const res = await jellyfinFetch(url, { headers: jellyfinAuthHeaders(config.jellyfin.apiKey), signal: upstreamSignal(SUBTITLE_TIMEOUT_MS) });
  // Une piste illisible n'empêche rien : le « Précédemment » se fait alors sur les résumés.
  if (!res.ok) return [];
  return parseSrt(await res.text());
}

/** Le modèle, remplaçable dans les tests — aucun appel réseau réel n'y part. */
export type RecapModel = (system: string, message: string) => Promise<{ raw: unknown; inTokens: number; outTokens: number }>;

/**
 * OpenAI ou Gemini (§140) : le même prompt et le même schéma, la réflexion « moyenne » qu'Anthropic a
 * gagnée au banc (`reasoning.effort` / `thinkingLevel`). Un refus ou une réponse coupée rendent `null`,
 * que `judgeRecap` lit « vide » — le même chemin qu'Anthropic ; une limite de débit garde son 429.
 */
async function askOtherProvider(system: string, message: string): Promise<Awaited<ReturnType<RecapModel>>> {
  try {
    const reply = await featureComplete(
      { system, stable: [], cache: false, user: message, schema: RECAP_SCHEMA as unknown as Record<string, unknown>, schemaName: "recap", maxOutputTokens: 8000, effort: "medium", signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) },
      "recap"
    );
    return { raw: reply.json ?? null, inTokens: reply.usage.inputTokens + reply.usage.cacheReadTokens, outTokens: reply.usage.outputTokens };
  } catch (error) {
    if (error instanceof ProviderError && error.kind === "rate") throw Object.assign(new Error(error.message), { status: 429 });
    if (error instanceof ProviderError && (error.kind === "refusal" || error.kind === "truncated" || error.kind === "invalid")) {
      return { raw: null, inTokens: error.usage?.inputTokens ?? 0, outTokens: error.usage?.outputTokens ?? 0 };
    }
    throw error;
  }
}

const askModel: RecapModel = async (system, message) => {
  if (featureSettings().provider !== "anthropic") return askOtherProvider(system, message);
  const client = new Anthropic({ apiKey: config.subtitleGen.apiKey.trim(), maxRetries: 0, timeout: MODEL_TIMEOUT_MS });
  const res = await anthropicTimed(client, system, message, "recap", {
    model: RECAP_MODEL,
    // La réflexion compte dans `max_tokens` : ~1 800 à 2 600 jetons au banc, la marge est large.
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: message }],
    // Réflexion adaptative, effort moyen — banc du 08/11/2026, 11 séries en cours × 4 réglages × 2 :
    // sans réflexion, Haiku prêtait des actes au mauvais personnage dans 4 séries sur 11 (« Nate a
    // passé la nuit avec Canaille ») et recopiait une fausse publicité de *The Boys* ; en effort moyen,
    // une erreur de lieu sur 22 textes, et *The Boys* laissé vide. L'effort haut ne fait pas mieux.
    // ~8 s et ~0,001 $ le texte : sans importance, tout est préparé en fond.
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: RECAP_SCHEMA } },
  });
  // Compté dans le plafond mensuel commun (§140).
  recordAiSpend(anthropicUsage(res.usage), featureSettings().price, "recap");
  let raw: unknown = null;
  // Un refus ou une réponse coupée ne suivent pas le schéma : vide plutôt qu'une moitié de JSON.
  if (res.stop_reason === "end_turn") {
    try {
      raw = JSON.parse(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
    } catch {
      raw = null;
    }
  }
  return { raw, inTokens: res.usage.input_tokens, outTokens: res.usage.output_tokens };
};

let model: RecapModel = askModel;
export function setRecapModelForTests(fn: RecapModel | null): void {
  model = fn ?? askModel;
}
/** Le modèle réel (celui des réglages) — pour vérifier l'aiguillage vers un fournisseur doublé (§140). */
export function defaultRecapModelForTests(): RecapModel {
  return askModel;
}

/** Une limite de débit : le passage s'arrête au premier refus (règle des bancs, 08/11/2026). */
class RecapRateLimited extends Error {}

type Outcome = "préparé" | "gardé" | "officiel" | "rejeté" | "vide" | "déjà" | "pas encore" | "aucun";

/**
 * Préparer le « Précédemment » d'une série pour un compte, s'il y a lieu (règles de Louis, 08/11/2026) :
 * - rien regardé de la série depuis dix minutes (et, vérifié par le passage, aucune lecture en cours) ;
 * - aucun épisode fini : rien (`aucun`) — sans résumé officiel où s'appuyer, des dialogues seuls sont
 *   trop risqués, la fiche garde le synopsis ;
 * - un seul résumé et pas de dialogues (épisode suivant pas commencé, ou sans sous-titres) : ce résumé
 *   tel quel (`officiel`), sans modèle — rien à condenser ;
 * - sinon le modèle, qui reçoit le texte que ce compte avait plus tôt dans l'histoire et le garde si
 *   les dix minutes de plus n'ont rien apporté d'important.
 * Le résultat — même un rejet — est gardé.
 */
export async function prepareRecap(
  account: { jfId: string; user: string; locale: Locale },
  state: { seriesId: string; series: string; episode: JellyfinItem; positionS: number },
  now = Date.now()
): Promise<Outcome> {
  const key = recapKey(state.episode.Id, state.positionS, account.locale);
  const order = (state.episode.ParentIndexNumber ?? 0) * 1000 + (state.episode.IndexNumber ?? 0);
  const step = recapStep(state.positionS);
  if (recapDb.get(key)) {
    recapDb.setLast(account.jfId, state.seriesId, key, order, step);
    return "déjà";
  }
  const episodes = await episodesOf(account.jfId, state.seriesId);
  const lastPlayed = Math.max(0, ...episodes.map((e) => Date.parse(e.UserData?.LastPlayedDate ?? "") || 0));
  if (now - lastPlayed < RECAP_IDLE_MS) return "pas encore";
  const at = episodes.findIndex((e) => e.Id === state.episode.Id);
  const current = episodes[at];
  const done = (at < 0 ? [] : episodes.slice(0, at))
    .filter((e) => e.UserData?.Played && (e.Overview ?? "").trim())
    .map((e) => ({ code: code(e), title: e.Name, overview: (e.Overview ?? "").trim() }));
  if (!current || !done.length) {
    recapDb.put(key, state.seriesId, "aucun", null, now);
    return "aucun";
  }
  const cues = state.positionS >= RECAP_STARTED_S ? await cuesOf(current, account.locale) : [];
  const hasDialogue = cues.some((c) => c.startS <= state.positionS);
  if (!hasDialogue && done.length === 1) {
    recapDb.put(key, state.seriesId, "officiel", done[0].overview, now, done[0].code);
    recapDb.setLast(account.jfId, state.seriesId, key, order, step);
    logRecap({ user: account.user, series: state.series, episode: code(current), minute: Math.floor(state.positionS / 60), status: "officiel", source: "résumés", ms: 0 });
    return "officiel";
  }
  // Seulement un texte d'avant dans l'histoire : revenu en arrière, le compte n'a plus le droit à
  // celui qu'il avait plus loin.
  const last = recapDb.lastOf(account.jfId, state.seriesId);
  const before = last && (last.epOrder < order || (last.epOrder === order && last.step < step));
  const previous = before ? (recapDb.get(last.key)?.text ?? null) : null;
  const input = recapSources({ series: state.series, current: { code: code(current), title: current.Name }, positionS: state.positionS, done, cues, previous });
  const started = Date.now();
  const base = { user: account.user, series: state.series, episode: code(current), minute: Math.floor(state.positionS / 60), source: input.usedDialogue ? ("dialogues" as const) : ("résumés" as const) };
  let answer: Awaited<ReturnType<RecapModel>>;
  try {
    answer = await model(recapSystem(account.locale), input.message);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    logRecap({ ...base, status: status === 429 ? "limite" : "erreur", ms: Date.now() - started });
    if (status === 429) throw new RecapRateLimited();
    throw err;
  }
  const verdict = judgeRecap(answer.raw, input.sources, previous);
  recapDb.put(key, state.seriesId, verdict.status, verdict.status === "ok" ? verdict.text : null, now);
  if (verdict.status === "ok") recapDb.setLast(account.jfId, state.seriesId, key, order, step);
  const kept = verdict.status === "ok" && verdict.kept;
  logRecap({ ...base, status: kept ? "gardé" : verdict.status, ms: Date.now() - started, inTokens: answer.inTokens, outTokens: answer.outTokens, ...(verdict.status === "rejeté" ? { names: verdict.names } : {}) });
  return kept ? "gardé" : verdict.status === "ok" ? "préparé" : verdict.status;
}

/** `compte:série` de tout ce qui joue en ce moment, pause comprise — la télé aussi. */
async function seriesBeingWatched(): Promise<Set<string>> {
  const sessions = await fetchJson<{ UserId?: string; NowPlayingItem?: { SeriesId?: string } }[]>(
    `${config.jellyfin.url}/Sessions?ActiveWithinSeconds=900`,
    { headers: jellyfinAuthHeaders(config.jellyfin.apiKey) }
  );
  return new Set(sessions.filter((x) => x.UserId && x.NowPlayingItem?.SeriesId).map((x) => `${x.UserId}:${x.NowPlayingItem!.SeriesId}`));
}

const PASS_KEY = Symbol.for("cine-app.recapPass");
const shared = globalThis as typeof globalThis & { [PASS_KEY]?: { running: boolean; started: boolean } };
const pass = (shared[PASS_KEY] ??= { running: false, started: false });

/**
 * Un passage : les comptes du foyer qui se servent de Laterna (sans les liens de partage, sans ceux
 * qui ont coupé l'option),
 * leurs séries en cours, une préparation à la fois. Une série qu'un compte est en train de regarder
 * (même en pause, sur n'importe quel appareil, d'après `/Sessions`) est laissée : sa position avance
 * en continu, et Jellyfin ne date parfois une lecture qu'à son début.
 * Arrêté au premier refus de débit ou à la première panne. Il tourne même quand quelqu'un regarde un
 * film : la première version attendait que plus rien ne joue nulle part, et avec un foyer entier, elle
 * n'a jamais tourné (08/11/2026). Lire les sous-titres d'un épisode est une lecture comme une autre.
 */
export async function runRecapPass(now = Date.now()): Promise<{ prepared: number; rejected: number }> {
  const result = { prepared: 0, rejected: 0 };
  // Le plafond mensuel atteint (§140) : rien de nouveau n'est préparé, en silence — la fiche garde les
  // textes déjà prêts, puis son synopsis. La ligne du journal est écrite une fois, quand il est franchi.
  if (!recapAvailable() || pass.running || aiBudgetReached(now)) return result;
  pass.running = true;
  try {
    recapDb.prune(PRUNE_AFTER_MS, now);
    let made = 0;
    const watching = await seriesBeingWatched();
    // Seulement les comptes qui se servent de Laterna (une session vivante, vue depuis moins de sept
    // jours) : le compte de la télé ne passe que par d'autres applications, et recevait des textes
    // que personne ne lirait (08/11/2026). Un compte qui revient est repris dès sa connexion.
    const active = sessionDb.activeUsers();
    for (const user of await jellyfin.getUsers()) {
      if (!active.has(user.Id) || !userPrefsDb.getShowRecap(user.Id)) continue;
      const locale = accountLocale(user.Id);
      for (const state of await positionsOf(user.Id, now)) {
        if (made >= PER_PASS || aiBudgetReached()) return result;
        if (watching.has(`${user.Id}:${state.seriesId}`)) continue;
        // Même déjà prêt (par un autre compte au même endroit), le passage note où en est ce compte.
        const outcome = await prepareRecap({ jfId: user.Id, user: user.Name, locale }, state, now);
        if (outcome === "préparé" || outcome === "gardé" || outcome === "rejeté" || outcome === "vide") made++;
        if (outcome === "préparé" || outcome === "gardé" || outcome === "officiel") result.prepared++;
        if (outcome === "rejeté" || outcome === "vide") result.rejected++;
      }
    }
  } catch (err) {
    if (!(err instanceof RecapRateLimited)) logError("recap", err);
  } finally {
    pass.running = false;
    if (result.prepared || result.rejected) taskLog("précédemment", "passage fait", { préparés: result.prepared, écartés: result.rejected });
  }
  return result;
}

export function startRecapCron(): void {
  if (pass.started) return;
  pass.started = true;
  const run = () => void runRecapPass();
  setTimeout(run, STARTUP_DELAY_MS).unref?.();
  setInterval(run, INTERVAL_MS).unref?.();
}
