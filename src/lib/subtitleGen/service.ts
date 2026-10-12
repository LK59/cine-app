import crypto from "node:crypto";
import { jellyfin, type JellyfinMediaSource, type JellyfinMediaStream } from "@/lib/clients/jellyfin";
import { config } from "@/lib/config";
import { budgetOf } from "./pricing";
import { genAvailable, genSettings } from "./providers";
import { TARGET_LANGUAGES, isTargetLanguage, twoLetter } from "./languages";
import { orderCandidates, presentLanguages, isTextSubtitle } from "./source";
import { DAILY_LIMIT, cuesDb, jobsDb, quotaDb, sameFile, spendDb, type JobRow, type JobStatus } from "./store";
import { cancelJob, markStale, noteViewer, prepare, resumeJob, startEngine, viewersOf } from "./engine";
import { logGen } from "./log";
import { fileUrlOf } from "./direct";

export { fileUrlOf };

/**
 * Ce que les routes `/api/subtitle-gen/*` demandent au moteur (DECISIONS.md §69) — le contrat
 * partagé avec le lecteur, écrit une seule fois ici.
 */

export interface JobSummary {
  jobId: string;
  target: string;
  status: JobStatus;
  done: number;
  total: number;
  reason?: string;
  /** Jellyfin liste-t-il déjà le sous-titre posé à côté du film ? */
  presented: boolean;
}

export interface GenOptions {
  enabled: boolean;
  targets: string[];
  existing: string[];
  jobs: JobSummary[];
  quota: { used: number; limit: number };
}

export interface Caller {
  user: string;
  jfId: string;
  /** La langue de l'interface du compte, proposée en premier. */
  locale: string;
}

/** Démarrer le moteur au premier appel (le démarrage du serveur le fait aussi, `instrumentation.ts`). */
function engine(): void {
  startEngine();
}

function summary(job: JobRow): JobSummary {
  return {
    jobId: job.id,
    target: job.target,
    status: job.status,
    done: job.done,
    total: job.total,
    ...(job.reason ? { reason: job.reason } : {}),
    presented: job.present_state === "presented",
  };
}

interface ItemFacts {
  source: JellyfinMediaSource;
  streams: JellyfinMediaStream[];
  name: string | null;
  runtime: number | null;
}

async function itemFacts(caller: Caller, itemId: string, mediaSourceId?: string): Promise<ItemFacts | null> {
  const item = await jellyfin.getItemMediaSources(caller.jfId, itemId);
  const source = (mediaSourceId ? item.MediaSources?.find((s) => s.Id === mediaSourceId) : null) ?? item.MediaSources?.[0];
  if (!source) return null;
  return { source, streams: source.MediaStreams ?? [], name: item.Name ?? null, runtime: item.RunTimeTicks ? item.RunTimeTicks / 10_000_000 : null };
}

/** La langue de tournage, faute de mieux : celle de la piste audio par défaut, ou de la première. */
function originalLanguage(streams: JellyfinMediaStream[]): string | null {
  const audio = streams.filter((s) => s.Type === "Audio");
  return twoLetter((audio.find((s) => s.IsDefault) ?? audio[0])?.Language);
}

/**
 * Les tâches de ce fichier, la dernière par langue. Une tâche dont le fichier a changé devient
 * obsolète au passage — c'est ici qu'on le voit d'abord, avant même le lecteur.
 */
function jobsForFile(itemId: string, source: JellyfinMediaSource): JobRow[] {
  const latest = new Map<string, JobRow>();
  for (const job of jobsDb.forItem(itemId)) {
    if (job.media_source_id !== source.Id) continue;
    if (!sameFile(job, { etag: source.ETag ?? null, size: typeof source.Size === "number" ? source.Size : null })) {
      markStale(job, "file-changed");
      continue;
    }
    latest.set(job.target, job);
  }
  return [...latest.values()];
}

/** Les langues déjà là : pistes texte complètes, et nos copies servies depuis `data/`. */
function existingLanguages(streams: JellyfinMediaStream[], jobs: JobRow[]): string[] {
  const out = new Set(presentLanguages(streams));
  for (const job of jobs) if (job.status === "done" && job.present_state === "failed") out.add(job.target);
  return [...out];
}

export async function genOptions(caller: Caller, itemId: string): Promise<GenOptions> {
  const quota = { used: quotaDb.used(caller.user), limit: DAILY_LIMIT };
  const closed: GenOptions = { enabled: false, targets: [], existing: [], jobs: [], quota };
  if (!genAvailable()) return closed;
  engine();
  const facts = await itemFacts(caller, itemId);
  if (!facts) return closed;
  const jobs = jobsForFile(itemId, facts.source);
  const existing = existingLanguages(facts.streams, jobs);
  const hasSource = facts.streams.some(isTextSubtitle);
  const ordered = [caller.locale, ...TARGET_LANGUAGES].filter((l, i, all) => isTargetLanguage(l) && all.indexOf(l) === i);
  return {
    enabled: hasSource,
    targets: hasSource ? ordered.filter((l) => !existing.includes(l)) : [],
    existing,
    jobs: jobs.map(summary),
    quota,
  };
}

export type CreateResult =
  | { ok: true; jobId: string; status: JobStatus }
  | { ok: false; status: number; error: "disabled" | "invalid" | "not-found" | "exists" | "no-source" | "budget" | "quota" };

export async function createOrJoin(
  caller: Caller,
  body: { itemId: string; mediaSourceId?: string; target: string; position?: number },
  viewerKey: string
): Promise<CreateResult> {
  if (!genAvailable()) return { ok: false, status: 404, error: "disabled" };
  if (!isTargetLanguage(body.target)) return { ok: false, status: 400, error: "invalid" };
  engine();
  const facts = await itemFacts(caller, body.itemId, body.mediaSourceId);
  if (!facts) return { ok: false, status: 404, error: "not-found" };
  const jobs = jobsForFile(body.itemId, facts.source);
  if (existingLanguages(facts.streams, jobs).includes(body.target)) return { ok: false, status: 409, error: "exists" };

  // Rejoindre : une tâche par fichier et par langue, partagée entre comptes. Ni rejoindre ni
  // reprendre ne compte dans le quota.
  const live = jobsDb.findLive(body.itemId, facts.source.Id, body.target);
  if (live) {
    noteViewer(live.id, viewerKey, body.position);
    return { ok: true, jobId: live.id, status: live.status };
  }

  const candidates = orderCandidates(facts.streams, body.target, originalLanguage(facts.streams));
  if (candidates.length === 0) return { ok: false, status: 422, error: "no-source" };
  if (spendDb.month().cost >= budgetOf(config.subtitleGen.budgetUsd)) return { ok: false, status: 402, error: "budget" };
  // Une tâche refaite (obsolète, annulée, échouée) pour le même titre et la même langue n'est pas
  // une génération de plus : seul un premier lancement compte.
  const fresh = !jobsDb.hadAny(body.itemId, body.target);
  if (fresh) {
    if (quotaDb.used(caller.user) >= DAILY_LIMIT) return { ok: false, status: 429, error: "quota" };
    quotaDb.add(caller.user);
  }

  const settings = genSettings();
  const id = crypto.randomBytes(16).toString("hex");
  jobsDb.insert({
    id,
    item_id: body.itemId,
    media_source_id: facts.source.Id,
    file_etag: facts.source.ETag ?? null,
    file_size: typeof facts.source.Size === "number" ? facts.source.Size : null,
    video_path: facts.source.Path ?? null,
    title: facts.name,
    runtime_seconds: facts.runtime,
    target: body.target,
    candidates: JSON.stringify(candidates),
    provider: settings.provider,
    model: settings.model,
    created_by: caller.user,
    last_position: typeof body.position === "number" && Number.isFinite(body.position) ? body.position : null,
  });
  logGen("start", { job: id, item: body.itemId, title: facts.name, target: body.target, candidates: candidates.length, provider: settings.provider, model: settings.model, user: caller.user });
  noteViewer(id, viewerKey, body.position);
  void prepare(id);
  return { ok: true, jobId: id, status: "preparing" };
}

export interface PollReply {
  status: JobStatus;
  reason?: string;
  rev: number;
  done: number;
  total: number;
  presented: boolean;
  cues: { i: number; start: number; end: number; text: string }[];
  fileUrl?: string;
}

export function pollJob(jobId: string, since: number, position: number | undefined, viewerKey: string): PollReply | null {
  const job = jobsDb.get(jobId);
  if (!job) return null;
  engine();
  if (job.status === "running" || job.status === "preparing") noteViewer(jobId, viewerKey, position);
  const cues = cuesDb.since(jobId, Number.isFinite(since) && since > 0 ? since : 0).map((c) => ({ i: c.idx, start: c.start_s, end: c.end_s, text: c.text as string }));
  return {
    status: job.status,
    ...(job.reason ? { reason: job.reason } : {}),
    rev: job.rev,
    done: job.done,
    total: job.total,
    presented: job.present_state === "presented",
    cues,
    ...(job.status === "done" ? { fileUrl: fileUrlOf(job.id) } : {}),
  };
}



export function resume(jobId: string): JobRow | null {
  engine();
  return resumeJob(jobId);
}

export function cancel(jobId: string): JobRow | null {
  return cancelJob(jobId);
}

/** Le panneau d'administration : réglages effectifs (jamais la clé), dépense du mois, tâches. */
export function adminSummary() {
  const settings = genSettings();
  const month = spendDb.month();
  return {
    available: genAvailable(settings),
    provider: settings.provider,
    model: settings.model,
    hasKey: settings.hasKey,
    price: settings.price,
    budgetUsd: budgetOf(config.subtitleGen.budgetUsd),
    month: { cost: month.cost, inputTokens: month.inputTokens, outputTokens: month.outputTokens, requests: month.requests },
    jobs: jobsDb.recent(50).map((j) => ({
      ...summary(j),
      itemId: j.item_id,
      title: j.title,
      provider: j.provider,
      model: j.model,
      cost: j.cost_usd,
      createdBy: j.created_by,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
      presentState: j.present_state,
      presentReason: j.present_reason,
      viewers: viewersOf(j.id).length,
    })),
  };
}
