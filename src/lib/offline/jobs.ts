import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";
import { config } from "@/lib/config";
import { DATA_DIR } from "@/lib/dataDir";
import { APP_VERSION } from "@/lib/appBuild";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { passJellyfinFetch } from "@/lib/jellyfinBreaker";
import { logError } from "@/lib/logger";
import { parseInit, scanFragments } from "./fmp4";
import { logOfflineEvent, noteOfflineTitle, type JellyfinNaming } from "./events";
import { expectedBytes, OFFLINE_AUDIO_BPS, OFFLINE_QUALITIES, type OfflineCodec, type OfflineQuality } from "./quality";

/**
 * Les préparations du téléchargement hors ligne (bêta, 19/10/2026 — docs/telechargement-hors-ligne.md).
 *
 * Jellyfin transcode une version légère en MP4 fragmenté ; ce module la lit au fil de l'eau et
 * l'écrit sur le disque de l'application (`data/offline/<id>.mp4`), pendant que l'appareil
 * télécharge déjà ce qui est écrit (`/api/offline/jobs/<id>/file`). La préparation ne dépend pas de
 * l'appareil : quitter l'application ne l'arrête pas, et le fichier fini attend qu'on revienne.
 *
 * Deux qualités, tranchées le 19/10 après un test à l'œil (lot « Qualité hors ligne ») : Standard,
 * 2 Mb/s — Jellyfin choisit alors le 720p — et Haute, 4 Mb/s, le plus bas débit où il garde le 1080p.
 * Son AAC stéréo d'une seule piste (un transcodage n'en sort qu'une), HDR converti en SDR par
 * Jellyfin. Une même version (titre, fichier, piste, qualité, codec) sert tous les comptes qui la
 * demandent.
 *
 * Plusieurs préparations à la fois (Louis ne voulait pas d'une seule) : `MAX_RUNNING`, à mesurer.
 * Un redémarrage du serveur pendant une préparation la reprend de zéro sous une nouvelle
 * `generation` — Jellyfin ne sait pas reprendre un transcodage progressif là où il s'était arrêté,
 * et ses octets ne seraient pas les mêmes ; l'appareil qui gardait l'ancien début recommence.
 */

export type { OfflineCodec, OfflineQuality } from "./quality";
export type OfflineStatus = "queued" | "running" | "done" | "failed";

const AUDIO_BPS = OFFLINE_AUDIO_BPS;
/** Combien de préparations tournent ensemble ; les autres attendent leur tour. */
const MAX_RUNNING = 2;
/** Gardée sur le serveur trois jours après le dernier téléchargement. */
const KEEP_MS = 3 * 24 * 3600_000;
const FAILED_KEEP_MS = 24 * 3600_000;
/** Une marge de place libre sur le disque des données, au-delà du fichier attendu. */
const DISK_MARGIN = 5 * 1024 ** 3;
const DEVICE_ID = "cine-offline";
const STALL_MS = 120_000;

export interface OfflineJob {
  id: string;
  itemId: string;
  fileVersion: string;
  audioIndex: number;
  quality: OfflineQuality;
  codec: OfflineCodec;
  status: OfflineStatus;
  generation: number;
  bytes: number;
  expectedBytes: number;
  runtimeSeconds: number;
  error: string | null;
}

interface Row {
  id: string;
  item_id: string;
  file_version: string;
  audio_index: number;
  quality: string;
  codec: string;
  status: string;
  generation: number;
  bytes: number;
  expected_bytes: number;
  runtime_s: number;
  error: string | null;
}

function fromRow(row: Row): OfflineJob {
  return {
    id: row.id,
    itemId: row.item_id,
    fileVersion: row.file_version,
    audioIndex: row.audio_index,
    quality: row.quality as OfflineQuality,
    codec: row.codec as OfflineCodec,
    status: row.status as OfflineStatus,
    // Pendant la préparation, ce qui est écrit à l'instant, pas la dernière valeur notée en base.
    generation: row.generation,
    bytes: live.running.get(row.id)?.bytes ?? row.bytes,
    expectedBytes: row.expected_bytes,
    runtimeSeconds: row.runtime_s,
    error: row.error,
  };
}

export const offlineDir = () => path.join(DATA_DIR, "offline");
export const offlineFile = (id: string) => path.join(offlineDir(), `${id}.mp4`);


interface Running {
  controller: AbortController;
  bytes: number;
  playSessionId: string;
}
interface Live {
  running: Map<string, Running>;
  /** Les index des fragments déjà lus, par version (`offlineIndex`). */
  indexes: Map<string, { generation: number; initEnd: number; video: import("./fmp4").Fmp4Track | null; fragments: { offset: number; size: number; time: number }[]; next: number }>;
  timers: ReturnType<typeof setInterval>[];
  started: boolean;
}
// Sur `globalThis` : `instrumentation.ts` et les routes sont des points d'entrée séparés, et chacun
// aurait sa copie du module (CLAUDE.md, server-cache).
const LIVE_KEY = Symbol.for("cine-app.offlineJobs");
const shared = globalThis as typeof globalThis & { [LIVE_KEY]?: Live };
const live: Live = (shared[LIVE_KEY] ??= { running: new Map(), indexes: new Map(), timers: [], started: false });
live.indexes ??= new Map();

const identity = () => ({ client: "CineApp", device: "Téléchargements", deviceId: DEVICE_ID, version: APP_VERSION });

export class OfflineRefusal extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Ce que Jellyfin dit du fichier : sa version, sa durée, ses pistes son. */
async function describeItem(itemId: string): Promise<{ fileVersion: string; mediaSourceId: string; runtimeSeconds: number; audioIndexes: number[] }> {
  const res = await passJellyfinFetch(`${config.jellyfin.url}/Items?ids=${jellyfinIdSegment(itemId)}&fields=MediaSources`, {
    headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new OfflineRefusal(`Jellyfin a répondu ${res.status}`, 502);
  const page = (await res.json()) as {
    Items?: (JellyfinNaming & { RunTimeTicks?: number; MediaSources?: { Id?: string; ETag?: string; MediaStreams?: { Type?: string; Index?: number }[] }[] })[];
  };
  const item = page.Items?.[0];
  const source = item?.MediaSources?.[0];
  if (!item || !source?.Id) throw new OfflineRefusal("Titre introuvable", 404);
  // Le nom du titre et de ses pistes, pour le journal : la même réponse, rien à redemander.
  noteOfflineTitle(itemId, item);
  if (item.Type !== "Movie" && item.Type !== "Episode") throw new OfflineRefusal("Seuls les films et les épisodes se téléchargent", 400);
  const runtimeSeconds = (item.RunTimeTicks ?? 0) / 1e7;
  if (!(runtimeSeconds > 0)) throw new OfflineRefusal("Durée inconnue", 409);
  return {
    fileVersion: source.ETag ?? source.Id,
    mediaSourceId: source.Id,
    runtimeSeconds,
    audioIndexes: (source.MediaStreams ?? []).filter((s) => s.Type === "Audio" && typeof s.Index === "number").map((s) => s.Index!),
  };
}

function freeBytes(): number | null {
  try {
    const stats = fs.statfsSync(DATA_DIR);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Demande une version pour un compte : reprise si elle existe déjà (prête, en cours ou en attente),
 * relancée si elle avait échoué, créée sinon. Le compte est noté parmi ceux qui l'attendent.
 */
export async function requestOfflineJob(input: {
  account: string;
  itemId: string;
  audioIndex: number;
  quality: OfflineQuality;
  codec: OfflineCodec;
  now?: number;
}): Promise<OfflineJob> {
  const now = input.now ?? Date.now();
  const item = await describeItem(input.itemId);
  if (!item.audioIndexes.includes(input.audioIndex)) throw new OfflineRefusal("Piste son inconnue", 400);
  const db = getDb();
  const existing = db
    .prepare(
      "SELECT * FROM offline_jobs WHERE item_id = ? AND file_version = ? AND audio_index = ? AND quality = ? AND codec = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(input.itemId, item.fileVersion, input.audioIndex, input.quality, input.codec) as Row | undefined;
  let id: string;
  // Ce que le journal dit de la version au moment de la demande : déjà prête (rien à préparer),
  // en préparation (un autre compte l'a demandée), relancée après un échec, ou nouvelle.
  const copy = !existing ? "new" : existing.status === "done" ? "ready" : existing.status === "failed" ? "retried" : "preparing";
  if (existing) {
    id = existing.id;
    if (existing.status === "failed") {
      db.prepare("UPDATE offline_jobs SET status = 'queued', generation = generation + 1, bytes = 0, error = NULL, accessed_at = ? WHERE id = ?").run(now, id);
    } else {
      db.prepare("UPDATE offline_jobs SET accessed_at = ? WHERE id = ?").run(now, id);
    }
  } else {
    const expected = expectedBytes(item.runtimeSeconds, input.quality);
    const free = freeBytes();
    if (free !== null && free < expected + DISK_MARGIN) throw new OfflineRefusal("Plus assez de place sur le serveur pour préparer ce téléchargement", 507);
    id = randomBytes(16).toString("hex");
    db.prepare(
      `INSERT INTO offline_jobs (id, item_id, file_version, audio_index, quality, codec, status, generation, bytes, expected_bytes, runtime_s, created_at, accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, 0, ?, ?, ?, ?)`
    ).run(id, input.itemId, item.fileVersion, input.audioIndex, input.quality, input.codec, expected, item.runtimeSeconds, now, now);
  }
  db.prepare("INSERT OR IGNORE INTO offline_requests (account, job_id, created_at) VALUES (?, ?, ?)").run(input.account, id, now);
  const asked = offlineJobFor(input.account, id)!;
  void logOfflineEvent("requested", asked, { user: input.account, copy, expectedBytes: asked.expectedBytes });
  pump();
  return offlineJobFor(input.account, id)!;
}

/** La version, si ce compte l'a demandée. */
export function offlineJobFor(account: string, id: string): OfflineJob | null {
  const row = getDb()
    .prepare("SELECT j.* FROM offline_jobs j JOIN offline_requests r ON r.job_id = j.id WHERE j.id = ? AND r.account = ?")
    .get(id, account) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Noté à chaque lecture du fichier : c'est ce qui le garde sur le serveur. */
export function touchOfflineJob(id: string, now = Date.now()): void {
  getDb().prepare("UPDATE offline_jobs SET accessed_at = ? WHERE id = ?").run(now, id);
}

/**
 * Le compte ne la veut plus (annulation ou suppression sur l'appareil). Une préparation que plus
 * personne n'attend s'arrête et disparaît ; une version prête reste jusqu'à son expiration, pour qui
 * la redemanderait.
 */
export function forgetOfflineJob(account: string, id: string): boolean {
  const db = getDb();
  const removed = db.prepare("DELETE FROM offline_requests WHERE account = ? AND job_id = ?").run(account, id).changes > 0;
  if (!removed) return false;
  const others = db.prepare("SELECT COUNT(*) AS n FROM offline_requests WHERE job_id = ?").get(id) as { n: number };
  const row = db.prepare("SELECT * FROM offline_jobs WHERE id = ?").get(id) as Row | undefined;
  const stopped = others.n === 0 && !!row && row.status !== "done";
  if (row) {
    const job = fromRow(row);
    // Une version prête retirée de l'appareil reste sur le serveur ; avant, c'est une annulation —
    // et la préparation s'arrête si plus personne ne l'attend (`stopped`).
    const done = row.status === "done";
    void logOfflineEvent(done ? "removed" : "cancelled", job, { user: account, status: row.status, bytes: job.bytes, ...(!done && { stopped }) });
  }
  if (stopped) dropJob(id);
  return true;
}

/** Les comptes qui attendent une version, pour les lignes qui les concernent tous. */
function accountsOf(id: string): string[] {
  return (getDb().prepare("SELECT account FROM offline_requests WHERE job_id = ? ORDER BY created_at").all(id) as { account: string }[]).map((r) => r.account);
}

function dropJob(id: string): void {
  live.indexes.delete(id);
  const running = live.running.get(id);
  if (running) running.controller.abort();
  getDb().prepare("DELETE FROM offline_requests WHERE job_id = ?").run(id);
  getDb().prepare("DELETE FROM offline_jobs WHERE id = ?").run(id);
  fs.rm(offlineFile(id), { force: true }, () => {});
}

interface AdminRow extends Row {
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  accessed_at: number;
  accounts: string | null;
}

/** Une version telle que l'Activité la montre à l'administrateur : son état, ses dates, ses comptes. */
export interface OfflineCopy extends OfflineJob {
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  accessedAt: number;
  /** Quand le balayage l'effacera s'il ne se passe rien d'ici là ; `null` tant qu'elle se prépare. */
  expiresAt: number | null;
  /** Les comptes qui l'attendent (ou l'ont sur leur appareil), dans l'ordre de leur demande. */
  accounts: string[];
}

/** Combien de jours une version prête reste sur le serveur après son dernier téléchargement. */
export const OFFLINE_KEEP_DAYS = KEEP_MS / (24 * 3600_000);

/**
 * Toutes les versions du serveur, pour l'Activité (administrateur seul) : les préparations d'abord,
 * puis les plus récemment touchées. L'expiration se calcule avec les règles du balayage lui-même
 * (`sweepOfflineJobs`), pour que la date affichée soit celle où il passera.
 */
export function listOfflineCopies(): OfflineCopy[] {
  const rows = getDb()
    .prepare(
      `SELECT j.*, (SELECT GROUP_CONCAT(account, char(10)) FROM (SELECT account FROM offline_requests r WHERE r.job_id = j.id ORDER BY r.created_at)) AS accounts
       FROM offline_jobs j
       ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, j.accessed_at DESC`
    )
    .all() as AdminRow[];
  return rows.map((row) => ({
    ...fromRow(row),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    accessedAt: row.accessed_at,
    expiresAt: row.status === "done" ? row.accessed_at + KEEP_MS : row.status === "failed" ? (row.finished_at ?? row.created_at) + FAILED_KEEP_MS : null,
    accounts: row.accounts ? row.accounts.split("\n") : [],
  }));
}

/** La place que prennent les versions (`data/offline`) et celle qui reste sur le disque des données. */
export function offlineDiskUsage(): { usedBytes: number; freeBytes: number | null } {
  let usedBytes = 0;
  try {
    for (const name of fs.readdirSync(offlineDir())) {
      try {
        usedBytes += fs.statSync(path.join(offlineDir(), name)).size;
      } catch {
        /* effacé entre-temps */
      }
    }
  } catch {
    /* pas encore de dossier */
  }
  return { usedBytes, freeBytes: freeBytes() };
}

/**
 * L'administrateur efface une version du serveur, depuis l'Activité. Une préparation en cours
 * s'arrête ; les appareils qui l'avaient déjà entière la gardent (elle est chez eux), ceux qui la
 * téléchargeaient encore recevront 404 et diront qu'elle n'existe plus.
 */
export function deleteOfflineCopy(id: string, admin: string): boolean {
  const row = getDb().prepare("SELECT * FROM offline_jobs WHERE id = ?").get(id) as Row | undefined;
  if (!row) return false;
  void logOfflineEvent("deleted", fromRow(row), { user: admin, accounts: accountsOf(id), status: row.status, bytes: fromRow(row).bytes });
  dropJob(id);
  return true;
}

/** Lance les préparations en attente, dans la limite de `MAX_RUNNING`. */
function pump(): void {
  if (!config.player.offlineDownloads) return;
  const db = getDb();
  while (live.running.size < MAX_RUNNING) {
    const next = db
      .prepare(
        `SELECT * FROM offline_jobs WHERE status = 'queued' ${live.running.size ? `AND id NOT IN (${[...live.running.keys()].map(() => "?").join(",")})` : ""} ORDER BY created_at LIMIT 1`
      )
      .get(...live.running.keys()) as Row | undefined;
    if (!next) return;
    void run(fromRow(next));
  }
}

async function run(job: OfflineJob): Promise<void> {
  const db = getDb();
  const controller = new AbortController();
  const playSessionId = `${job.id}${job.generation}`;
  const state: Running = { controller, bytes: 0, playSessionId };
  live.running.set(job.id, state);
  const startedAt = Date.now();
  db.prepare("UPDATE offline_jobs SET status = 'running', started_at = ?, bytes = 0, error = NULL WHERE id = ?").run(startedAt, job.id);
  void logOfflineEvent("started", job, { accounts: accountsOf(job.id), generation: job.generation, expectedBytes: job.expectedBytes });
  fs.mkdirSync(offlineDir(), { recursive: true });
  const file = offlineFile(job.id);
  let failure: string | null = null;
  // Un flux qui ne donne plus rien pendant deux minutes : Jellyfin a calé. Sans ce garde, la
  // préparation resterait « en cours » pour toujours et occuperait sa place dans la file.
  let lastByteAt = Date.now();
  let stalled = false;
  const noteBytes = setInterval(() => {
    if (Date.now() - lastByteAt > STALL_MS) {
      stalled = true;
      controller.abort();
    }
    try {
      db.prepare("UPDATE offline_jobs SET bytes = ? WHERE id = ?").run(state.bytes, job.id);
    } catch {
      /* la ligne a pu disparaître (annulation) */
    }
  }, 5000);
  try {
    const item = await describeItem(job.itemId);
    if (item.fileVersion !== job.fileVersion) throw new Error("le fichier a changé dans la bibliothèque");
    const query = new URLSearchParams({
      Static: "false",
      MediaSourceId: item.mediaSourceId,
      VideoCodec: job.codec,
      AudioCodec: "aac",
      AudioStreamIndex: String(job.audioIndex),
      AudioChannels: "2",
      AudioBitrate: String(AUDIO_BPS),
      VideoBitrate: String(OFFLINE_QUALITIES[job.quality].videoBps),
      MaxWidth: "1920",
      MaxHeight: "1080",
      PlaySessionId: playSessionId,
      DeviceId: DEVICE_ID,
      allowVideoStreamCopy: "false",
      allowAudioStreamCopy: "false",
    });
    const res = await passJellyfinFetch(`${config.jellyfin.url}/Videos/${jellyfinIdSegment(job.itemId)}/stream.mp4?${query}`, {
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey, identity()),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Jellyfin a répondu ${res.status}`);
    const out = fs.createWriteStream(file);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      state.bytes += value.byteLength;
      lastByteAt = Date.now();
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
    // Jellyfin ferme le flux aussi quand son transcodage meurt : n'est « prêt » qu'un fichier qui va
    // jusqu'au bout du film (le dernier fragment commence dans les trente dernières secondes).
    const lastTime = await lastFragmentTime(file, state.bytes);
    if (lastTime === null || lastTime < job.runtimeSeconds - 30) {
      throw new Error(`transcodage interrompu à ${lastTime === null ? "?" : Math.round(lastTime)} s sur ${Math.round(job.runtimeSeconds)} s`);
    }
  } catch (error) {
    failure = stalled ? "Jellyfin ne répond plus" : controller.signal.aborted ? "annulé" : error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(noteBytes);
    live.running.delete(job.id);
    void passJellyfinFetch(`${config.jellyfin.url}/Videos/ActiveEncodings?deviceId=${DEVICE_ID}&playSessionId=${playSessionId}`, {
      method: "DELETE",
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey, identity()),
    }).catch(() => {});
  }
  const stillThere = db.prepare("SELECT 1 FROM offline_jobs WHERE id = ?").get(job.id);
  if (stillThere) {
    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt;
    if (failure) {
      // L'échec s'écrit une fois, en ligne `offline` de niveau erreur — comptée comme avant parmi les
      // erreurs du serveur. C'était un `logError` dont la pile, née ici, ne disait rien de plus ; la
      // ligne porte en plus le titre et les comptes.
      if (failure !== "annulé") {
        void logOfflineEvent("failed", job, { level: "error", accounts: accountsOf(job.id), reason: failure, bytes: state.bytes, durationMs, generation: job.generation });
      }
      db.prepare("UPDATE offline_jobs SET status = 'failed', error = ?, bytes = ?, finished_at = ? WHERE id = ?").run(failure, state.bytes, finishedAt, job.id);
    } else {
      db.prepare("UPDATE offline_jobs SET status = 'done', bytes = ?, finished_at = ?, accessed_at = ? WHERE id = ?").run(state.bytes, finishedAt, finishedAt, job.id);
      void logOfflineEvent("ready", job, {
        accounts: accountsOf(job.id),
        bytes: state.bytes,
        durationMs,
        // Combien de fois plus vite que le film lui-même : la question qu'on se pose en attendant.
        speed: durationMs > 0 ? Math.round((job.runtimeSeconds / (durationMs / 1000)) * 10) / 10 : null,
        runtimeSeconds: Math.round(job.runtimeSeconds),
        generation: job.generation,
      });
    }
  }
  pump();
}

async function lastFragmentTime(file: string, size: number): Promise<number | null> {
  const handle = await fs.promises.open(file, "r");
  try {
    const read = async (offset: number, length: number) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      await handle.read(buffer, 0, buffer.length, offset);
      return new Uint8Array(buffer);
    };
    const init = parseInit(await read(0, Math.min(size, 4 * 1024 * 1024)));
    const video = init?.tracks.find((t) => t.kind === "video");
    if (!init || !video) return null;
    const { fragments } = await scanFragments(read, init.end, size, video);
    return fragments.length ? fragments[fragments.length - 1].time : null;
  } finally {
    await handle.close();
  }
}

/**
 * L'index des fragments d'une version, lu sur le disque du serveur — pour le lecteur d'un
 * téléchargement en cours (`/api/offline/jobs/<id>/index`). L'appareil le construisait lui-même en
 * lisant l'en-tête de chaque fragment, par le réseau tant qu'il n'était pas arrivé : des centaines de
 * petites requêtes en file, et l'ouverture tombait sur « bloqué à l'étape index des fragments »
 * (Chrome de Louis, 19/10/2026). Ici, quelques millisecondes ; gardé en mémoire et prolongé au fil de
 * la préparation, à partir de là où on s'était arrêté.
 */
export async function offlineIndex(job: OfflineJob, from: number): Promise<{ fragments: { offset: number; size: number; time: number }[]; next: number }> {
  const file = offlineFile(job.id);
  const size = job.bytes;
  const cached = live.indexes.get(job.id);
  const entry = cached && cached.generation === job.generation ? cached : { generation: job.generation, initEnd: 0, video: null, fragments: [], next: 0 };
  live.indexes.set(job.id, entry);
  if (entry.next < size) {
    const handle = await fs.promises.open(file, "r");
    try {
      const read = async (offset: number, length: number) => {
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        await handle.read(buffer, 0, buffer.length, offset);
        return new Uint8Array(buffer);
      };
      if (!entry.video) {
        const init = parseInit(await read(0, Math.min(size, 4 * 1024 * 1024)));
        const video = init?.tracks.find((t) => t.kind === "video");
        if (init && video) {
          entry.video = video;
          entry.initEnd = init.end;
          entry.next = init.end;
        }
      }
      if (entry.video) {
        const scanned = await scanFragments(read, entry.next, size, entry.video);
        entry.fragments.push(...scanned.fragments);
        entry.next = scanned.next;
      }
    } finally {
      await handle.close();
    }
  }
  const start = entry.fragments.findIndex((f) => f.offset >= from);
  return { fragments: start < 0 ? [] : entry.fragments.slice(start), next: Math.max(from, entry.next) };
}

/** Efface les versions que plus personne ne télécharge, et les échecs d'hier. */
export function sweepOfflineJobs(now = Date.now()): void {
  const db = getDb();
  const stale = db
    .prepare("SELECT * FROM offline_jobs WHERE (status = 'done' AND accessed_at < ?) OR (status = 'failed' AND COALESCE(finished_at, created_at) < ?)")
    .all(now - KEEP_MS, now - FAILED_KEEP_MS) as AdminRow[];
  for (const row of stale) {
    void logOfflineEvent("expired", fromRow(row), { accounts: accountsOf(row.id), status: row.status, bytes: row.bytes, lastAccess: row.accessed_at });
    dropJob(row.id);
  }
  // Les fichiers sans ligne (une suppression interrompue) : effacés aussi.
  try {
    const known = new Set((db.prepare("SELECT id FROM offline_jobs").all() as { id: string }[]).map((r) => r.id));
    for (const name of fs.readdirSync(offlineDir())) {
      if (name.endsWith(".mp4") && !known.has(name.slice(0, -4))) fs.rmSync(path.join(offlineDir(), name), { force: true });
    }
  } catch {
    /* pas encore de dossier */
  }
}

/** Au démarrage : les préparations coupées par l'arrêt repartent de zéro, puis la file reprend. */
export function startOfflineJobs(): void {
  if (live.started) return;
  live.started = true;
  const db = getDb();
  const cut = db.prepare("SELECT id FROM offline_jobs WHERE status = 'running'").all() as { id: string }[];
  for (const { id } of cut) {
    fs.rmSync(offlineFile(id), { force: true });
    db.prepare("UPDATE offline_jobs SET status = 'queued', generation = generation + 1, bytes = 0 WHERE id = ?").run(id);
  }
  sweepOfflineJobs();
  pump();
  const sweep = setInterval(() => {
    try {
      sweepOfflineJobs();
      pump();
    } catch (error) {
      logError("offline", error);
    }
  }, 30 * 60_000);
  sweep.unref?.();
  live.timers.push(sweep);
}
