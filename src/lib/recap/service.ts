// « Précédemment » (DECISIONS.md §137) — Jellyfin, le modèle, la base, et la tâche de fond.
//
// Rien n'est préparé à l'ouverture d'une fiche : lire les sous-titres d'un épisode prend 12 à 45 s à
// Jellyfin quand ils sont dans le fichier (mesuré le 08/11/2026). La tâche de fond prépare donc, pour
// chaque compte qui ouvre l'application, ses séries en cours laissées depuis trois heures ; la fiche
// lit ce qui est prêt, en une requête pour toutes (`readyRecapsFor`), ou garde son résumé habituel.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "@/lib/config";
import { recapDb } from "@/lib/db";
import { jellyfin, type JellyfinItem } from "@/lib/clients/jellyfin";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { upstreamSignal } from "@/lib/http";
import { DEFAULT_MODELS } from "@/lib/subtitleGen/pricing";
import { logRecap } from "@/lib/eventLogs";
import { logError } from "@/lib/logger";
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
  RECAP_MIN_PLAYED,
  RECAP_SCHEMA,
  RECAP_STARTED_S,
  type Cue,
  type SubtitleStream,
} from "@/lib/recap/core";

export const RECAP_MODEL = DEFAULT_MODELS.anthropic;
/** Les séries « À suivre » regardées par compte : les plus récentes d'abord, comme Jellyfin les rend. */
const SERIES_PER_ACCOUNT = 8;
/** Au plus par passage : un compte qui revient après un mois ne fait pas trente appels d'un coup. */
const PER_PASS = 12;
/** Un compte qui n'a pas ouvert l'application depuis ce temps n'a plus rien de préparé. */
const ACCOUNT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
/** Réactif (Louis, 08/11/2026) : dix minutes après l'arrêt, le texte est prêt dans les cinq qui suivent. */
const INTERVAL_MS = 5 * 60 * 1000;
const MODEL_TIMEOUT_MS = 30_000;
const SUBTITLE_TIMEOUT_MS = 90_000;

export function recapAvailable(): boolean {
  return config.recap.enabled && config.subtitleGen.provider === "anthropic" && config.subtitleGen.apiKey.trim() !== "";
}

export function recapLocale(value: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : "fr";
}

const code = (item: Pick<JellyfinItem, "ParentIndexNumber" | "IndexNumber">) =>
  `S${String(item.ParentIndexNumber ?? 0).padStart(2, "0")}E${String(item.IndexNumber ?? 0).padStart(2, "0")}`;
const positionOf = (item: JellyfinItem) => Math.floor((item.UserData?.PlaybackPositionTicks ?? 0) / 10_000_000);

/**
 * Où en est un compte, série par série : l'épisode que Jellyfin propose ensuite (l'épisode commencé,
 * sinon le suivant du dernier vu) et la position dedans. Lu avec l'identifiant du compte : ses tags
 * bloqués s'appliquent, une série qui lui est cachée n'y est pas.
 */
async function positionsOf(jfId: string): Promise<{ seriesId: string; series: string; episode: JellyfinItem; positionS: number }[]> {
  const items = await jellyfin.getNextUpGlobal(jfId, SERIES_PER_ACCOUNT);
  return items.filter((e) => e.SeriesId).map((e) => ({ seriesId: e.SeriesId!, series: e.SeriesName ?? "", episode: e, positionS: positionOf(e) }));
}

/** Les « Précédemment » prêts pour ce compte, par série — ce que la fiche lit. */
export async function readyRecapsFor(jfId: string, locale: Locale): Promise<Record<string, { text: string; episode: string }>> {
  const states = await positionsOf(jfId);
  const keys = states.map((s) => recapKey(s.episode.Id, s.positionS, locale));
  const ready = recapDb.readyAmong(keys);
  const out: Record<string, { text: string; episode: string }> = {};
  states.forEach((s, i) => {
    const text = ready.get(keys[i]);
    if (text) out[s.seriesId] = { text, episode: code(s.episode) };
  });
  return out;
}

type EpisodeWithStreams = JellyfinItem & { MediaStreams?: SubtitleStream[]; MediaSources?: { Id: string }[] };

async function episodesOf(jfId: string, seriesId: string): Promise<EpisodeWithStreams[]> {
  const url = `${config.jellyfin.url}/Shows/${jellyfinIdSegment(seriesId)}/Episodes?userId=${jellyfinIdSegment(jfId)}&Fields=Overview,UserData,MediaStreams,MediaSources`;
  const res = await jellyfinFetch(url, { headers: jellyfinAuthHeaders(config.jellyfin.apiKey), signal: upstreamSignal(15_000) });
  if (!res.ok) throw new Error(`Jellyfin ${res.status} sur les épisodes`);
  const body = (await res.json()) as { Items?: EpisodeWithStreams[] };
  // Les épisodes spéciaux (saison 0) ne sont pas dans le fil de l'histoire.
  return (body.Items ?? []).filter((e) => (e.ParentIndexNumber ?? 0) > 0);
}

async function cuesOf(episode: EpisodeWithStreams, locale: Locale): Promise<Cue[]> {
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

const askModel: RecapModel = async (system, message) => {
  const client = new Anthropic({ apiKey: config.subtitleGen.apiKey.trim(), maxRetries: 0, timeout: MODEL_TIMEOUT_MS });
  const res = await client.messages.create({
    model: RECAP_MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content: message }],
    // Comme la recherche par description : sans réflexion, effort bas — choisi au banc du 08/11/2026.
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: RECAP_SCHEMA } },
  });
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

/** Une limite de débit : le passage s'arrête au premier refus (règle des bancs, 08/11/2026). */
class RecapRateLimited extends Error {}

type Outcome = "préparé" | "gardé" | "rejeté" | "vide" | "déjà" | "pas encore" | "trop peu";

/**
 * Préparer le « Précédemment » d'une série pour un compte, s'il y a lieu : plus de deux épisodes
 * finis, et rien regardé de la série depuis dix minutes. Le résultat — même un rejet — est gardé.
 * Le texte que ce compte avait plus tôt dans l'histoire est donné au modèle, qui le garde si les dix
 * minutes de plus n'ont rien apporté d'important.
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
  const played = episodes.filter((e) => e.UserData?.Played);
  if (played.length < RECAP_MIN_PLAYED) return "trop peu";
  const lastPlayed = Math.max(0, ...episodes.map((e) => Date.parse(e.UserData?.LastPlayedDate ?? "") || 0));
  if (now - lastPlayed < RECAP_IDLE_MS) return "pas encore";
  const at = episodes.findIndex((e) => e.Id === state.episode.Id);
  if (at < 0) return "trop peu";
  const current = episodes[at];
  const done = episodes
    .slice(0, at)
    .filter((e) => e.UserData?.Played)
    .map((e) => ({ code: code(e), title: e.Name, overview: e.Overview ?? "" }));
  if (!done.some((e) => e.overview.trim())) return "trop peu";
  const cues = state.positionS >= RECAP_STARTED_S ? await cuesOf(current, account.locale) : [];
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

const PASS_KEY = Symbol.for("cine-app.recapPass");
const shared = globalThis as typeof globalThis & { [PASS_KEY]?: { running: boolean; started: boolean } };
const pass = (shared[PASS_KEY] ??= { running: false, started: false });

/**
 * Un passage : les comptes venus depuis un mois, leurs séries en cours, une préparation à la fois.
 * Arrêté au premier refus de débit ou à la première panne. Il tourne même quand quelqu'un regarde un
 * film : la première version attendait que plus rien ne joue nulle part, et avec un foyer entier, elle
 * n'a jamais tourné (08/11/2026). Lire les sous-titres d'un épisode est une lecture comme une autre.
 */
export async function runRecapPass(now = Date.now()): Promise<{ prepared: number; rejected: number }> {
  const result = { prepared: 0, rejected: 0 };
  if (!recapAvailable() || pass.running) return result;
  pass.running = true;
  try {
    recapDb.prune(PRUNE_AFTER_MS, now);
    let made = 0;
    for (const account of recapDb.accountsSince(now - ACCOUNT_IDLE_MS)) {
      const locale = recapLocale(account.locale);
      for (const state of await positionsOf(account.jfId)) {
        if (made >= PER_PASS) return result;
        // Même déjà prêt (par un autre compte au même endroit), le passage note où en est ce compte.
        const outcome = await prepareRecap({ jfId: account.jfId, user: account.user, locale }, state, now);
        if (outcome === "préparé" || outcome === "gardé" || outcome === "rejeté" || outcome === "vide") made++;
        if (outcome === "préparé" || outcome === "gardé") result.prepared++;
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
