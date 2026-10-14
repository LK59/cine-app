import fs from "node:fs/promises";
import { config } from "@/lib/config";
import { logError, SERVER_LOG_FILE, SERVER_LOG_KEEP } from "@/lib/logger";
import { appendJsonLine } from "@/lib/logFile";
import { diskOf, planQueues, type QueuePlan } from "./disks";
import { indexFilm } from "./indexFilm";
import { languagesForFilm } from "./languages";
import { checkMoviesMount, libraryFilms, type LibraryFilm, type MountCheck } from "./library";
import { mustWaitForPlayback } from "./playbackActivity";
import { listSidecars, type Sidecar } from "./sidecar";
import {
  deleteFilmLines,
  filmErrors,
  filmRecords,
  forgetFilm,
  indexCounts,
  readMeta,
  repliquesDbBytes,
  saveFilm,
  wipeRepliquesDb,
  writeLines,
  writeMeta,
  writeStats,
} from "./store";

/**
 * L'indexation des répliques : une passe qui lit les films et remplit `repliques.db` (DECISIONS.md §88).
 *
 * **Une seule mécanique pour les deux usages.** « Indexation initiale » et « Mise à jour chaque nuit »
 * font la même chose : comparer chaque film de la bibliothèque à ce que l'index en sait (sa
 * signature : taille et date du fichier, fichiers de sous-titres posés à côté, langues voulues),
 * relire ce qui a changé — un film nouveau, un film réencodé par FileFlows, un `.srt` ajouté —, et
 * retirer ce qui a disparu. La première fois, tout a changé. Ce qui les distingue : l'initiale part
 * d'un bouton et tourne à toute heure ; la nuit ne part que dans sa plage, une fois par nuit, et
 * seulement après une initiale terminée (sans quoi activer l'option lancerait d'elle-même une passe
 * complète, que l'administrateur doit décider).
 *
 * **Jamais en concurrence avec un film regardé.** Chaque lecture de fichier passe par `gate` : pause
 * demandée, option coupée, sortie de la plage de nuit — on s'arrête ; quelqu'un regarde — on attend,
 * et l'on reprend quelques minutes après (`playbackActivity.ts`). Entre deux lectures, un court repos
 * et un plafond de débit : la priorité d'entrée-sortie « idle » (`ionice -c 3`) n'aurait aucun effet
 * ici — les fichiers passent par mergerfs (FUSE), dont le démon fait les vraies lectures avec sa propre
 * priorité, et l'ordonnanceur des disques est `mq-deadline` (relevé le 14/10/2026).
 *
 * **La reprise.** L'état de la passe est écrit dans la base à chaque film : un conteneur recréé
 * reprend au film suivant (le film interrompu est effacé puis relu).
 */

const RUN_KEY = "run";
const INITIAL_DONE_KEY = "initialDone";
const LAST_NIGHT_KEY = "lastNight";

/** Un court repos avant chaque lecture : la tête du disque est libre pour d'autres un tiers du temps. */
const READ_PAUSE_MS = 2;
/** Le débit plafond d'une lecture complète (un vieux fichier sans index) — 25 Mo/s. */
const MAX_BYTES_PER_MS = 25_000;
/** L'attente entre deux vérifications pendant qu'on regarde un film. */
const PLAYBACK_POLL_MS = 15_000;
/** Une ligne au journal tous les… */
const LOG_EVERY_FILMS = 25;
/** Après un redémarrage, une passe interrompue reprend après ce délai — le démarrage a sa propre charge. */
const RESUME_DELAY_MS = 2 * 60_000;
const NIGHT_CHECK_MS = 5 * 60_000;

export type RunKind = "initial" | "nightly";

export interface RunState {
  kind: RunKind;
  startedAt: number;
  finishedAt: number | null;
  /** Films à lire dans cette passe (y compris ceux déjà lus avant un redémarrage). */
  total: number;
  done: number;
  errors: number;
  removed: number;
  bytesRead: number;
  /** Le temps passé à lire, attentes exclues — la base de l'estimation. */
  activeMs: number;
  lastFilm: string | null;
  userPaused: boolean;
}

export type Phase = "idle" | "planning" | "running" | "waiting-playback" | "paused" | "outside-window" | "disabled" | "unavailable" | "done";

class Stop extends Error {
  constructor(readonly why: "paused" | "disabled" | "window" | "rebuild") {
    super(`arrêt: ${why}`);
  }
}

const live = {
  phase: "idle" as Phase,
  playbackBy: null as string | null,
  currentFilms: new Set<string>(),
  queues: { count: 1, reason: "unproven" } as { count: number; reason: QueuePlan<unknown>["reason"] },
  loop: null as Promise<void> | null,
  stopWhy: null as Stop["why"] | null,
  lastReadAt: 0,
  wake: null as (() => void) | null,
  timers: [] as ReturnType<typeof setTimeout>[],
  /** L'attente entre deux vérifications pendant une lecture (raccourcie par les tests). */
  pollMs: PLAYBACK_POLL_MS,
};

function info(message: string, context: Record<string, unknown> = {}): void {
  const entry = { timestamp: new Date().toISOString(), level: "info", scope: "repliques", message, ...context };
  console.log(JSON.stringify(entry));
  appendJsonLine(SERVER_LOG_FILE, entry, { keep: SERVER_LOG_KEEP });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      live.wake = null;
      resolve();
    }, ms);
    // Une pause demandée réveille l'attente tout de suite.
    live.wake = () => {
      clearTimeout(timer);
      live.wake = null;
      resolve();
    };
  });

/** Dans la plage de nuit ? Une plage qui passe minuit (22 → 6) est prise en compte. */
export function inNightWindow(now: Date, start: number, end: number): boolean {
  const h = now.getHours();
  if (start === end) return true;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** La nuit à laquelle appartient un instant : la date du début de sa plage (22 h → 6 h compte pour la veille). */
export function nightKey(now: Date, start: number): string {
  const shifted = new Date(now.getTime());
  if (now.getHours() < start) shifted.setDate(shifted.getDate() - 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}-${String(shifted.getDate()).padStart(2, "0")}`;
}

function readRun(): RunState | null {
  try {
    return readMeta<RunState>(RUN_KEY);
  } catch {
    return null;
  }
}

function saveRun(run: RunState): void {
  writeMeta(RUN_KEY, run);
}

/** La barrière de chaque lecture de fichier : arrêt, attente pendant un film, freinage. */
async function gate(kind: RunKind, bytes: number): Promise<void> {
  for (;;) {
    if (live.stopWhy) throw new Stop(live.stopWhy);
    if (!config.repliques.enabled) throw new Stop("disabled");
    if (kind === "nightly" && !inNightWindow(new Date(), config.repliques.nightStart, config.repliques.nightEnd)) throw new Stop("window");
    const { wait, signal } = await mustWaitForPlayback();
    if (!wait) break;
    if (live.phase !== "waiting-playback") info("en pause : lecture en cours", { by: signal.by });
    live.phase = "waiting-playback";
    live.playbackBy = signal.by;
    await sleep(live.pollMs);
  }
  if (live.phase === "waiting-playback") info("reprise après la lecture");
  live.phase = "running";
  live.playbackBy = null;
  // Le freinage : un repos minimal, et un débit plafond pour les gros morceaux (lecture complète).
  const gap = READ_PAUSE_MS + bytes / MAX_BYTES_PER_MS;
  const wait = live.lastReadAt + gap - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  live.lastReadAt = Date.now();
}

interface PlannedFilm {
  film: LibraryFilm;
  languages: string[];
  sidecars: Sidecar[];
  signature: string;
}

/** Ce qui décide qu'un film est à relire : son fichier, ses sous-titres posés à côté, les langues voulues. */
export function filmSignature(size: number, mtimeMs: number, sidecars: readonly Sidecar[], languages: readonly string[]): string {
  const side = sidecars.map((s) => `${s.file.split("/").pop()}:${s.size}:${s.mtimeMs}`).join("|");
  return `v1;${size};${Math.round(mtimeMs)};${languages.join(",")};${side}`;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function plan(): Promise<{ todo: PlannedFilm[]; removed: string[] }> {
  const films = await libraryFilms();
  const records = filmRecords();
  const setting = config.repliques.languages;
  const todo: PlannedFilm[] = [];
  const present = new Set<string>();
  let n = 0;
  for (const film of films) {
    present.add(film.itemId);
    if (++n % 50 === 0) await yieldToLoop();
    let stat;
    try {
      stat = await fs.stat(film.file);
    } catch {
      // Introuvable à son chemin : rien à lire. S'il était indexé, il le reste jusqu'à ce que Radarr le retire.
      continue;
    }
    const sidecars = await listSidecars(film.file);
    const languages = languagesForFilm(setting, film.originalLanguage);
    const signature = filmSignature(stat.size, stat.mtimeMs, sidecars, languages);
    const known = records.get(film.itemId);
    if (known && known.signature === signature && known.status !== "error") continue;
    todo.push({ film, languages, sidecars, signature });
  }
  const removed = [...records.keys()].filter((id) => !present.has(id));
  return { todo, removed };
}

async function indexOne(item: PlannedFilm, run: RunState): Promise<void> {
  const { film } = item;
  live.currentFilms.add(film.title);
  const t0 = Date.now();
  try {
    // Un film relu (ou interrompu par un redémarrage) repart d'une page blanche.
    await deleteFilmLines(film.itemId);
    const result = await indexFilm({ ...film, languages: item.languages, sidecars: item.sidecars }, (bytes) => gate(run.kind, bytes));
    await writeLines(result.rows);
    const ms = Date.now() - t0;
    saveFilm({
      itemId: film.itemId,
      radarrId: film.radarrId,
      title: film.title,
      path: film.file,
      signature: item.signature,
      status: result.rows.length > 0 ? "ok" : "empty",
      sources: result.sources,
      error: null,
      lines: result.rows.length,
      bytesRead: result.bytesRead,
      ms,
      indexedAt: Date.now(),
    });
    run.bytesRead += result.bytesRead;
    run.activeMs += ms;
  } catch (error) {
    if (error instanceof Stop) throw error;
    const message = error instanceof Error ? error.message : String(error);
    run.errors++;
    run.activeMs += Date.now() - t0;
    logError("repliques.film", error, { film: film.title, file: film.file });
    try {
      saveFilm({ itemId: film.itemId, radarrId: film.radarrId, title: film.title, path: film.file, signature: item.signature, status: "error", sources: null, error: message.slice(0, 300), lines: 0, bytesRead: 0, ms: Date.now() - t0, indexedAt: Date.now() });
    } catch {
      /* l'erreur est au journal */
    }
  } finally {
    live.currentFilms.delete(film.title);
  }
  run.done++;
  run.lastFilm = film.title;
  saveRun(run);
  if (run.done % LOG_EVERY_FILMS === 0) info("lot", { done: run.done, total: run.total, errors: run.errors, bytesRead: run.bytesRead });
}

/** Les disques de chaque film — on s'arrête au premier sans preuve : il suffit à tout lire en série. */
async function queuesFor(todo: PlannedFilm[]): Promise<QueuePlan<PlannedFilm>> {
  const disks: (string[] | null)[] = [];
  for (const item of todo) {
    const disk = await diskOf(item.film.file).catch(() => null);
    disks.push(disk);
    if (!disk) return planQueues(todo, todo.map(() => null));
  }
  return planQueues(todo, disks);
}

async function runPass(kind: RunKind): Promise<void> {
  live.phase = "planning";
  live.stopWhy = null;
  const mount = await checkMoviesMount();
  if (!mount.ok) {
    live.phase = "unavailable";
    info("dossier des films indisponible", { problem: mount.problem });
    return;
  }
  const previous = readRun();
  const resuming = previous && previous.finishedAt === null && previous.kind === kind;
  const { todo, removed } = await plan();
  const run: RunState = resuming
    ? { ...previous, total: previous.done + todo.length, userPaused: false }
    : { kind, startedAt: Date.now(), finishedAt: null, total: todo.length, done: 0, errors: 0, removed: 0, bytesRead: 0, activeMs: 0, lastFilm: null, userPaused: false };
  for (const itemId of removed) {
    await deleteFilmLines(itemId);
    forgetFilm(itemId);
    run.removed++;
  }
  saveRun(run);
  info(resuming ? "reprise de la passe" : "début de la passe", { kind, films: todo.length, removed: removed.length });

  const queues = await queuesFor(todo);
  live.queues = { count: Math.max(1, queues.queues.length), reason: queues.reason };
  live.phase = "running";
  try {
    await Promise.all(
      queues.queues.map(async (queue) => {
        for (const item of queue) {
          if (live.stopWhy) throw new Stop(live.stopWhy);
          await indexOne(item, run);
        }
      }),
    );
    run.finishedAt = Date.now();
    saveRun(run);
    if (kind === "initial") writeMeta(INITIAL_DONE_KEY, true);
    if (kind === "nightly") writeMeta(LAST_NIGHT_KEY, nightKey(new Date(), config.repliques.nightStart));
    live.phase = "done";
    info("passe terminée", { kind, done: run.done, errors: run.errors, removed: run.removed, bytesRead: run.bytesRead, activeMs: run.activeMs });
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    // La pause demandée est retenue par l'état écrit : sans quoi cette écriture-ci l'effaçait.
    if (error.why === "paused") run.userPaused = true;
    saveRun(run);
    live.phase = error.why === "paused" ? "paused" : error.why === "disabled" ? "disabled" : error.why === "window" ? "outside-window" : "idle";
    info("passe arrêtée", { kind, why: error.why, done: run.done, total: run.total });
  }
}

function launch(kind: RunKind): void {
  if (live.loop) return;
  live.loop = runPass(kind)
    .catch((error) => {
      live.phase = "idle";
      logError("repliques.pass", error);
    })
    .finally(() => {
      live.loop = null;
      live.currentFilms.clear();
      live.stopWhy = null;
    });
}

async function stopLoop(why: Stop["why"]): Promise<void> {
  if (!live.loop) return;
  live.stopWhy = why;
  live.wake?.();
  await live.loop;
}

// ─── Ce que la page de Configuration appelle ────────────────────────────────

export type ActionRefusal = "disabled" | "unavailable" | "busy";

/** « Lancer » / « Reprendre » : une passe, initiale tant que la première n'est pas finie. */
export async function startIndexing(): Promise<ActionRefusal | null> {
  if (!config.repliques.enabled) return "disabled";
  if (live.loop) {
    // Déjà en route : seule une pause demandée et pas encore prise est levée.
    live.stopWhy = null;
    return null;
  }
  const mount = await checkMoviesMount();
  if (!mount.ok) return "unavailable";
  const run = readRun();
  if (run && run.userPaused) saveRun({ ...run, userPaused: false });
  // Toujours une passe « manuelle », à toute heure : une passe de nuit inachevée reprise d'ici ne doit
  // pas s'arrêter aussitôt pour cause de plage horaire.
  launch("initial");
  return null;
}

/** « Mettre en pause » : retenue, y compris à travers un redémarrage, jusqu'à « Reprendre ». */
export async function pauseIndexing(): Promise<void> {
  const run = readRun();
  if (run && run.finishedAt === null) saveRun({ ...run, userPaused: true });
  await stopLoop("paused");
  live.phase = "paused";
}

/** « Reconstruire l'index » : tout effacer (le fichier, instantanément) et repartir d'une initiale. */
export async function rebuildIndex(): Promise<ActionRefusal | null> {
  if (!config.repliques.enabled) return "disabled";
  const mount = await checkMoviesMount();
  if (!mount.ok) return "unavailable";
  await stopLoop("rebuild");
  wipeRepliquesDb();
  launch("initial");
  info("index reconstruit à neuf");
  return null;
}

export interface RepliquesStatus {
  enabled: boolean;
  mount: MountCheck;
  phase: Phase;
  playbackBy: string | null;
  currentFilms: string[];
  run: RunState | null;
  initialDone: boolean;
  lastNight: string | null;
  /** Estimation du temps restant (ms), attentes exclues — `null` sans base de calcul. */
  etaMs: number | null;
  index: { bytes: number; films: number; filmsWithLines: number; lines: number; errors: number };
  errors: { itemId: string; title: string; error: string; at: number }[];
  parallel: { queues: number; reason: string };
  write: { slices: number; maxSliceMs: number; totalMs: number };
  settings: { nightly: boolean; nightStart: number; nightEnd: number; languages: string };
}

export async function repliquesStatus(): Promise<RepliquesStatus> {
  const mount = await checkMoviesMount();
  const run = readRun();
  const remaining = run && run.finishedAt === null ? Math.max(0, run.total - run.done) : 0;
  const etaMs = run && run.done > 0 && remaining > 0 ? Math.round((run.activeMs / run.done) * remaining) : null;
  const unfinished = !!run && run.finishedAt === null;
  const phase: Phase = live.loop
    ? live.phase
    : !config.repliques.enabled
      ? "disabled"
      : !mount.ok
        ? "unavailable"
        : unfinished
          ? run!.userPaused
            ? "paused"
            : live.phase === "outside-window"
              ? "outside-window"
              : "idle"
          : run?.finishedAt
            ? "done"
            : "idle";
  return {
    enabled: config.repliques.enabled,
    mount,
    phase,
    playbackBy: live.playbackBy,
    currentFilms: [...live.currentFilms],
    run,
    initialDone: readMeta<boolean>(INITIAL_DONE_KEY) === true,
    lastNight: readMeta<string>(LAST_NIGHT_KEY),
    etaMs,
    index: { bytes: repliquesDbBytes(), ...indexCounts() },
    errors: filmErrors(20),
    parallel: { queues: live.queues.count, reason: live.queues.reason },
    write: { slices: writeStats.slices, maxSliceMs: Math.round(writeStats.maxSliceMs * 10) / 10, totalMs: Math.round(writeStats.totalMs) },
    settings: { nightly: config.repliques.nightly, nightStart: config.repliques.nightStart, nightEnd: config.repliques.nightEnd, languages: config.repliques.languages },
  };
}

/** Le moment d'une passe de nuit : option active, initiale finie, dans la plage, pas encore faite cette nuit. */
export function nightlyDue(now: Date, state: { enabled: boolean; nightly: boolean; initialDone: boolean; start: number; end: number; lastNight: string | null; userPaused: boolean }): boolean {
  if (!state.enabled || !state.nightly || !state.initialDone || state.userPaused) return false;
  if (!inNightWindow(now, state.start, state.end)) return false;
  return state.lastNight !== nightKey(now, state.start);
}

function nightTick(): void {
  try {
    if (live.loop) return;
    const run = readRun();
    const now = new Date();
    const due = nightlyDue(now, {
      enabled: config.repliques.enabled,
      nightly: config.repliques.nightly,
      initialDone: readMeta<boolean>(INITIAL_DONE_KEY) === true,
      start: config.repliques.nightStart,
      end: config.repliques.nightEnd,
      lastNight: readMeta<string>(LAST_NIGHT_KEY),
      userPaused: !!run?.userPaused && run.finishedAt === null,
    });
    if (due) launch("nightly");
  } catch (error) {
    logError("repliques.night", error);
  }
}

/** Démarrage du serveur : la passe interrompue reprend (sauf pause demandée), et la nuit est surveillée. */
export function startRepliquesEngine(): void {
  const resume = setTimeout(() => {
    try {
      if (!config.repliques.enabled) return;
      const run = readRun();
      if (run && run.finishedAt === null && !run.userPaused && run.kind === "initial") launch("initial");
    } catch (error) {
      logError("repliques.resume", error);
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
  stopLoop,
  gate,
  reset(): void {
    for (const t of live.timers) clearTimeout(t);
    live.timers = [];
    live.phase = "idle";
    live.stopWhy = null;
    live.loop = null;
    live.lastReadAt = 0;
    live.currentFilms.clear();
  },
  waitIdle: () => live.loop ?? Promise.resolve(),
  wipe: wipeRepliquesDb,
};
