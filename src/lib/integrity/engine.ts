import { logError, SERVER_LOG_FILE, SERVER_LOG_KEEP } from "@/lib/logger";
import { appendJsonLine } from "@/lib/logFile";
import { acquireDiskReads, diskReadsState, type DiskLease } from "@/lib/backgroundDiskReads";
import { mustWaitForPlayback } from "@/lib/repliques/playbackActivity";
import { libraryFiles, type LibraryFile } from "./library";
import { isMatroskaName, scanMatroska, SequentialFileSource } from "./scan";
import { integrityDb, type IntegrityRecord } from "./store";

/**
 * La vérification de l'intégrité des fichiers (DECISIONS.md §93) : une tâche de fond qui relit les
 * fichiers vidéo de la bibliothèque avec le lecteur du lecteur natif et sa détection des zones
 * illisibles, et liste les fichiers abîmés — avant qu'un spectateur ne tombe dessus.
 *
 * **Une seule mécanique pour la première passe et la nuit**, comme les répliques (§88) : chaque passe
 * compare chaque fichier à ce qu'en sait la table (chemin, taille, date), relit ce qui est nouveau,
 * modifié ou en erreur, et oublie ce qui a disparu. La première part du bouton « Vérifier l'intégrité
 * des fichiers », à toute heure ; la nuit (2 h – 6 h, heure du conteneur) ne part qu'après une
 * première passe terminée, une fois par nuit.
 *
 * **Polie avec les disques.** Une lecture à la fois, séquentielle, par blocs de 8 Mio. Avant chaque
 * bloc (`beforeBlock`) : arrêt demandé ? quelqu'un regarde ? (`mustWaitForPlayback`, le même signal
 * que les répliques — séances Jellyfin, relais de flux, battement de lecture — et la même reprise cinq
 * minutes après) — et le verrou commun (`backgroundDiskReads.ts`) : jamais en même temps que
 * l'indexation des répliques. Pendant une attente, le verrou est rendu. Un débit plafonné
 * (`MAX_BYTES_PER_MS`) et un court repos avant chaque bloc laissent la tête libre pour le reste.
 *
 * Rien n'est jamais écrit hors de la base de l'application : les fichiers sont ouverts en lecture.
 */

const RUN_KEY = "run";
const INITIAL_DONE_KEY = "initialDone";
const LAST_NIGHT_KEY = "lastNight";

/** Le débit plafond — 60 Mo/s, un tiers de ce que la lecture séquentielle seule donne ici (183 Mo/s, mesuré le 14/10/2026). */
export const MAX_BYTES_PER_MS = 60_000;
/** Un repos avant chaque bloc. */
const BLOCK_PAUSE_MS = 5;
/** Tenu plus longtemps que ça, le verrou est cédé à l'autre tâche si elle attend. */
const LEASE_SLICE_MS = 20_000;
const PLAYBACK_POLL_MS = 15_000;
const NIGHT_START = 2;
const NIGHT_END = 6;
const NIGHT_CHECK_MS = 5 * 60_000;
const RESUME_DELAY_MS = 3 * 60_000;
const LOG_EVERY_FILES = 50;
const PAUSE_WAIT_MS = 10_000;

export type IntegrityRunKind = "initial" | "nightly";

export interface IntegrityRun {
  kind: IntegrityRunKind;
  startedAt: number;
  finishedAt: number | null;
  /** Fichiers à relire dans cette passe. */
  total: number;
  done: number;
  damaged: number;
  errors: number;
  removed: number;
  bytesRead: number;
  /** Octets à relire dans cette passe (Matroska seulement), pour l'estimation. */
  bytesTotal: number;
  /** Le temps passé à lire, attentes exclues. */
  activeMs: number;
  lastFile: string | null;
  userPaused: boolean;
}

export type IntegrityPhase = "idle" | "planning" | "running" | "waiting-playback" | "waiting-disk" | "paused" | "outside-window" | "done";

class Stop extends Error {
  constructor(readonly why: "paused" | "window") {
    super(`arrêt: ${why}`);
  }
}

type Live = {
  phase: IntegrityPhase;
  current: string | null;
  loop: Promise<void> | null;
  stopWhy: Stop["why"] | null;
  run: IntegrityRun | null;
  lastReadAt: number;
  wakers: Set<() => void>;
  timers: ReturnType<typeof setTimeout>[];
  pollMs: number;
  /** Plafond de débit (octets/ms) — raccourci par les tests. */
  bytesPerMs: number;
  playbackBy: string | null;
};
const LIVE_KEY = Symbol.for("cine.integrity.live");
const shared = globalThis as typeof globalThis & { [LIVE_KEY]?: Live };
const live: Live = (shared[LIVE_KEY] ??= {
  phase: "idle",
  current: null,
  loop: null,
  stopWhy: null,
  run: null,
  lastReadAt: 0,
  wakers: new Set(),
  timers: [],
  pollMs: PLAYBACK_POLL_MS,
  bytesPerMs: MAX_BYTES_PER_MS,
  playbackBy: null,
});

function info(message: string, context: Record<string, unknown> = {}): void {
  const entry = { timestamp: new Date().toISOString(), level: "info", scope: "integrite", message, ...context };
  console.log(JSON.stringify(entry));
  appendJsonLine(SERVER_LOG_FILE, entry, { keep: SERVER_LOG_KEEP });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      live.wakers.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    live.wakers.add(wake);
  });

const wakeAll = () => {
  for (const wake of [...live.wakers]) wake();
};

export function inNightWindow(now: Date, start = NIGHT_START, end = NIGHT_END): boolean {
  const h = now.getHours();
  return start < end ? h >= start && h < end : h >= start || h < end;
}

export function nightKey(now: Date, start = NIGHT_START): string {
  const shifted = new Date(now.getTime());
  if (now.getHours() < start) shifted.setDate(shifted.getDate() - 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}-${String(shifted.getDate()).padStart(2, "0")}`;
}

function readRun(): IntegrityRun | null {
  try {
    return integrityDb.readMeta<IntegrityRun>(RUN_KEY);
  } catch {
    return null;
  }
}

/**
 * La barrière de chaque bloc : arrêt, plage de nuit, lecture d'un spectateur (verrou rendu pendant
 * l'attente), verrou cédé à l'autre tâche après une tranche, débit plafonné.
 */
class Gate {
  private lease: DiskLease | null = null;
  private heldSince = 0;

  constructor(private readonly kind: IntegrityRunKind) {}

  async before(bytes: number): Promise<void> {
    for (;;) {
      if (live.stopWhy) throw new Stop(live.stopWhy);
      if (this.kind === "nightly" && !inNightWindow(new Date())) throw new Stop("window");
      const { wait, signal } = await mustWaitForPlayback();
      if (!wait) break;
      this.releaseLease();
      if (live.phase !== "waiting-playback") info("en pause : lecture en cours", { by: signal.by });
      live.phase = "waiting-playback";
      live.playbackBy = signal.by;
      await sleep(live.pollMs);
    }
    if (live.phase === "waiting-playback") info("reprise après la lecture");
    live.playbackBy = null;
    // Le verrou commun : une tranche à la fois quand l'indexation des répliques attend.
    if (this.lease && this.lease.contended && Date.now() - this.heldSince > LEASE_SLICE_MS) this.releaseLease();
    if (!this.lease) {
      live.phase = "waiting-disk";
      this.lease = await acquireDiskReads("integrite");
      this.heldSince = Date.now();
      if (live.stopWhy) {
        this.releaseLease();
        throw new Stop(live.stopWhy);
      }
    }
    live.phase = "running";
    const gap = BLOCK_PAUSE_MS + bytes / live.bytesPerMs;
    const wait = live.lastReadAt + gap - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    live.lastReadAt = Date.now();
  }

  releaseLease(): void {
    this.lease?.release();
    this.lease = null;
  }
}

/** Relit un fichier. Rend la ligne à écrire ; `Stop` remonte. */
export async function checkFile(file: LibraryFile, gate: Pick<Gate, "before">): Promise<IntegrityRecord> {
  const base = { path: file.path, size: file.size, mtimeMs: file.mtimeMs, kind: file.kind, title: file.title, serviceId: file.serviceId };
  if (!isMatroskaName(file.path)) {
    // Un MP4 est lu par son index d'échantillons, sans en-tête à analyser en chemin : rien d'équivalent
    // à détecter sans tout décoder. Compté, pas relu.
    return { ...base, status: "unsupported", zones: [], error: null, bytesRead: 0, ms: 0, checkedAt: Date.now() };
  }
  const t0 = Date.now();
  let source: SequentialFileSource | null = null;
  try {
    source = await SequentialFileSource.open(file.path, { beforeBlock: (bytes) => gate.before(bytes) });
    const result = await scanMatroska(source);
    return {
      ...base,
      status: result.zones.length > 0 ? "damaged" : "ok",
      zones: result.zones,
      ...(result.truncated ? { truncated: true } : {}),
      ...(result.unreachableTail ? { unreachableTail: true } : {}),
      error: null,
      bytesRead: source.bytesRead,
      ms: Date.now() - t0,
      checkedAt: Date.now(),
    };
  } catch (error) {
    if (error instanceof Stop) throw error;
    return {
      ...base,
      status: "error",
      zones: [],
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      bytesRead: source?.bytesRead ?? 0,
      ms: Date.now() - t0,
      checkedAt: Date.now(),
    };
  } finally {
    source?.close();
  }
}

/** Ce qui est à relire : nouveau, modifié (taille ou date), ou en erreur. Et ce qui a disparu. */
export function planFiles(files: LibraryFile[], known: Map<string, { size: number; mtimeMs: number; status: string }>): { todo: LibraryFile[]; removed: string[] } {
  const present = new Set<string>();
  const todo: LibraryFile[] = [];
  for (const file of files) {
    present.add(file.path);
    const seen = known.get(file.path);
    if (seen && seen.size === file.size && seen.mtimeMs === Math.round(file.mtimeMs) && seen.status !== "error") continue;
    todo.push(file);
  }
  const removed = [...known.keys()].filter((p) => !present.has(p));
  return { todo, removed };
}

async function runPass(kind: IntegrityRunKind): Promise<void> {
  live.phase = "planning";
  live.stopWhy = null;
  const { files, settling } = await libraryFiles();
  const { todo, removed } = planFiles(files, integrityDb.signatures());
  for (const p of removed) integrityDb.forget(p);
  const previous = readRun();
  const resuming = !!previous && previous.finishedAt === null && previous.kind === kind;
  const bytesTotal = todo.reduce((n, f) => n + (isMatroskaName(f.path) ? f.size : 0), 0);
  const run: IntegrityRun = resuming
    ? { ...previous, total: previous.done + todo.length, bytesTotal: previous.bytesRead + bytesTotal, userPaused: false }
    : { kind, startedAt: Date.now(), finishedAt: null, total: todo.length, done: 0, damaged: 0, errors: 0, removed: removed.length, bytesRead: 0, bytesTotal, activeMs: 0, lastFile: null, userPaused: false };
  live.run = run;
  integrityDb.writeMeta(RUN_KEY, run);
  info(resuming ? "reprise de la passe" : "début de la passe", { kind, files: todo.length, bytes: bytesTotal, removed: removed.length, settling });

  const gate = new Gate(kind);
  live.phase = "running";
  try {
    for (const file of todo) {
      if (live.stopWhy) throw new Stop(live.stopWhy);
      live.current = file.title;
      const t0 = Date.now();
      const record = await checkFile(file, gate);
      integrityDb.save(record);
      run.done++;
      run.bytesRead += record.bytesRead;
      run.activeMs += record.ms;
      if (record.status === "damaged") {
        run.damaged++;
        info("fichier abîmé", { title: file.title, path: file.path, zones: record.zones.slice(0, 5) });
      }
      if (record.status === "error") {
        run.errors++;
        logError("integrite.file", new Error(record.error ?? "erreur"), { file: file.path });
      }
      run.lastFile = file.title;
      integrityDb.writeMeta(RUN_KEY, run);
      if (run.done % LOG_EVERY_FILES === 0) info("lot", { done: run.done, total: run.total, bytesRead: run.bytesRead, ms: Date.now() - t0 });
    }
    gate.releaseLease();
    run.finishedAt = Date.now();
    integrityDb.writeMeta(RUN_KEY, run);
    if (kind === "initial") integrityDb.writeMeta(INITIAL_DONE_KEY, true);
    if (kind === "nightly") integrityDb.writeMeta(LAST_NIGHT_KEY, nightKey(new Date()));
    live.phase = "done";
    info("passe terminée", { kind, done: run.done, damaged: run.damaged, errors: run.errors, bytesRead: run.bytesRead, activeMs: run.activeMs });
  } catch (error) {
    gate.releaseLease();
    if (!(error instanceof Stop)) throw error;
    if (error.why === "paused") run.userPaused = true;
    integrityDb.writeMeta(RUN_KEY, run);
    live.phase = error.why === "paused" ? "paused" : "outside-window";
    info("passe arrêtée", { kind, why: error.why, done: run.done, total: run.total });
  }
}

function launch(kind: IntegrityRunKind): void {
  if (live.loop) return;
  live.loop = runPass(kind)
    .catch((error) => {
      live.phase = "idle";
      logError("integrite.pass", error);
    })
    .finally(() => {
      live.loop = null;
      live.run = null;
      live.current = null;
      live.stopWhy = null;
    });
}

// ─── Ce que la page de contrôle appelle ──────────────────────────────────────

/** « Vérifier l'intégrité des fichiers » / « Reprendre » : une passe (manuelle), à toute heure. */
export function startIntegrityCheck(): "busy" | null {
  if (live.loop && !live.stopWhy) return null;
  if (live.loop) return "busy";
  const run = readRun();
  if (run && run.userPaused) integrityDb.writeMeta(RUN_KEY, { ...run, userPaused: false });
  launch("initial");
  return null;
}

/** « Mettre en pause » : retenue, même à travers un redémarrage, jusqu'à « Reprendre ». */
export async function pauseIntegrityCheck(): Promise<void> {
  const run = readRun();
  if (run && run.finishedAt === null) integrityDb.writeMeta(RUN_KEY, { ...run, userPaused: true });
  if (!live.loop) {
    live.phase = "paused";
    return;
  }
  live.stopWhy = "paused";
  wakeAll();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([live.loop, new Promise<void>((resolve) => (timer = setTimeout(resolve, PAUSE_WAIT_MS)))]);
  clearTimeout(timer);
  live.phase = "paused";
}

export interface IntegrityStatusView {
  phase: IntegrityPhase;
  current: string | null;
  playbackBy: string | null;
  /** L'autre tâche de fond qui tient les disques, quand on l'attend. */
  diskBusyWith: string | null;
  run: IntegrityRun | null;
  initialDone: boolean;
  lastNight: string | null;
  /** Le temps restant estimé (ms), au débit mesuré de cette passe, attentes exclues. */
  etaMs: number | null;
  counts: { ok: number; damaged: number; unsupported: number; error: number; bytes: number };
  problems: IntegrityRecord[];
}

export function integrityStatus(): IntegrityStatusView {
  const run = live.run ?? readRun();
  const unfinished = !!run && run.finishedAt === null;
  const phase: IntegrityPhase = live.loop ? live.phase : unfinished ? (run!.userPaused ? "paused" : "idle") : run?.finishedAt ? "done" : "idle";
  const remaining = run && unfinished ? Math.max(0, run.bytesTotal - run.bytesRead) : 0;
  const etaMs = run && unfinished && run.bytesRead > 0 && run.activeMs > 0 && remaining > 0 ? Math.round((run.activeMs / run.bytesRead) * remaining) : null;
  const disk = diskReadsState();
  return {
    phase,
    current: live.current,
    playbackBy: live.playbackBy,
    diskBusyWith: phase === "waiting-disk" && disk.owner && disk.owner !== "integrite" ? disk.owner : null,
    run,
    initialDone: integrityDb.readMeta<boolean>(INITIAL_DONE_KEY) === true,
    lastNight: integrityDb.readMeta<string>(LAST_NIGHT_KEY),
    etaMs,
    counts: integrityDb.counts(),
    problems: integrityDb.problems(),
  };
}

/** Le moment d'une passe de nuit : première passe terminée, dans la plage, pas encore faite cette nuit, pas en pause. */
export function nightlyDue(now: Date, state: { initialDone: boolean; lastNight: string | null; userPaused: boolean }): boolean {
  if (!state.initialDone || state.userPaused) return false;
  if (!inNightWindow(now)) return false;
  return state.lastNight !== nightKey(now);
}

function nightTick(): void {
  try {
    if (live.loop) return;
    const run = readRun();
    const due = nightlyDue(new Date(), {
      initialDone: integrityDb.readMeta<boolean>(INITIAL_DONE_KEY) === true,
      lastNight: integrityDb.readMeta<string>(LAST_NIGHT_KEY),
      userPaused: !!run?.userPaused && run.finishedAt === null,
    });
    if (due) launch("nightly");
  } catch (error) {
    logError("integrite.night", error);
  }
}

/** Démarrage du serveur : une passe manuelle interrompue reprend (sauf pause demandée), la nuit est surveillée. */
export function startIntegrityEngine(): void {
  const resume = setTimeout(() => {
    try {
      const run = readRun();
      if (run && run.finishedAt === null && !run.userPaused && run.kind === "initial") launch("initial");
    } catch (error) {
      logError("integrite.resume", error);
    }
  }, RESUME_DELAY_MS);
  resume.unref?.();
  const night = setInterval(nightTick, NIGHT_CHECK_MS);
  night.unref?.();
  live.timers.push(resume, night);
}

export const __testing = {
  live,
  launch,
  Gate,
  waitIdle: () => live.loop ?? Promise.resolve(),
  reset(): void {
    for (const t of live.timers) clearTimeout(t);
    live.timers = [];
    live.phase = "idle";
    live.current = null;
    live.loop = null;
    live.stopWhy = null;
    live.run = null;
    live.lastReadAt = 0;
    live.wakers.clear();
    live.pollMs = PLAYBACK_POLL_MS;
    live.bytesPerMs = MAX_BYTES_PER_MS;
    live.playbackBy = null;
  },
};
