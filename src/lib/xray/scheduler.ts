import { HttpError } from "@/lib/http";
import { xray, xrayConfigured, type XrayItemState } from "@/lib/clients/xray";
import { logError } from "@/lib/logger";
import { taskLog } from "@/lib/taskLog";
import { mustWaitForPlayback } from "@/lib/repliques/playbackActivity";
import { analysisTarget } from "./cast";
import { jobFor, keepsAnalysis, rebindAnalysis } from "./rebind";
import { analysisSpeed, buildPlan, etaSeconds, isLibraryPath, libraryRoots, NEW_WINDOW_MS, SCAN_TIERS, type ScanTier } from "./scanPlan";
import { readLibrary, readPriorityTitle, readWatching } from "./scanSources";
import {
  clearPriorityRows,
  dropUnseen,
  getRow,
  lastErrors,
  markRow,
  nextPending,
  planSize,
  priorityCounts,
  readMeta,
  recordFileVersion,
  reopenOutsideLibrary,
  reopenStale,
  rowsWithStatus,
  setPriorityRows,
  setWatching,
  speedSamples,
  staleDone,
  storedWatching,
  tierCounts,
  upsertPlanSlice,
  writeMeta,
  type ScanRow,
  type TierCounts,
  finishedSeries,
} from "./scanStore";

/**
 * Le planificateur des acteurs à l'écran (DECISIONS.md §138, « Le planificateur de la bibliothèque »,
 * 09/11/2026) : toute la bibliothèque analysée en fond, par paliers (`scanPlan.ts`), sans jamais gêner
 * une lecture.
 *
 * **Seulement quand personne ne regarde.** Le même signal que la recherche de répliques (§88,
 * `playbackActivity.ts`) : une séance Jellyfin qui lit (tout lecteur, téléviseurs compris), le relais
 * de flux dans la minute, un battement de lecture — et cinq minutes après le dernier. Pendant une
 * lecture, rien de neuf ne part ; ce qui est déjà dans la file du service y reste (deux éléments au
 * plus, en `low` — le service cède lui-même aux transcodages de Jellyfin, et une commande `high` d'un
 * spectateur passe devant). « Lancer maintenant » force un palier : il est nourri même pendant une
 * lecture, jusqu'à ce qu'il soit vide ou que l'administrateur retire le forçage.
 *
 * **Peu d'avance.** `MAX_PENDING` éléments à nous en file au plus, et rien si la file du service en a
 * déjà `MAX_SERVICE_PENDING` : la commande d'un spectateur (`high`) ne trouve jamais une longue file
 * devant elle, et une pause prend effet en un élément.
 *
 * **Un tour à la fois, chaque minute.** L'état vit sur `globalThis` (CLAUDE.md : `instrumentation.ts`
 * et les routes ont chacun leur copie du module), et un tour en cours est rendu à qui en demande un
 * autre. Ce qui doit survivre à un redémarrage est dans `cine.db` (`scanStore.ts`) : le plan, l'état
 * de chaque élément, les pauses et les forçages.
 *
 * **Déjà fait, rien ne part.** Avant de commander, le service est interrogé (`/items/{id}`) : fini au
 * même `ETag`, l'élément est compté fait ; fini à un autre `ETag` mais à durée égale (± 1 s), il est
 * rattaché (`rebind.ts`) au lieu d'être réanalysé. Un élément fini est relu lentement (`RECHECKS_PER_TICK`
 * par tour sans autre travail, chacun au plus une fois par `RECHECK_AFTER_MS`) : un fichier remplacé
 * change d'`ETag` et repasse à vérifier.
 *
 * **Un élément ne bloque jamais la file** (revue du 09/11/2026). Une erreur de TMDB ou de Jellyfin propre
 * à un élément (`HttpError`) le met en échec, retenté une semaine plus tard (`reopenStale`) ; une erreur
 * de réseau aussi, mais retentée dans l'heure, et le tour s'arrête là (une panne ne doit pas mettre vingt
 * éléments en échec par minute). Seul le service lui-même (`/health`, `/jobs` autre que 400, `/items`)
 * arrête le tour. Avant, la première erreur levée par `prepare` interrompait le tour, l'élément restait
 * en tête des `pending`, et chaque minute rejouait la même erreur : la file entière était arrêtée.
 *
 * **Aucune lecture inutile.** Tous les paliers en pause : rien n'est lu. Pendant une lecture sans palier
 * forcé ni liste de priorité à servir : ni le palier 1 ni le plan ne sont relus. Une relecture du plan
 * qui échoue n'est retentée qu'après 15 min, 1 h, puis 6 h (`PLAN_TRIED_KEY`) — elle était retentée à
 * chaque tour, soit la bibliothèque entière relue chaque minute ; et ce qui a réussi (la liste des
 * comptes) est gardé même quand l'autre moitié (la bibliothèque) échoue.
 *
 * **`next dev` ne planifie rien** : la pile de développement partage `data/cine.db` avec la production,
 * et deux planificateurs commanderaient en double sur le même plan (`devServer`).
 *
 * Le journal du conteneur : une ligne `[xray]` par lot vraiment commandé (avec le palier), par relecture
 * complète du plan et par palier terminé — jamais par tour. Les erreurs vont dans `server.log`.
 */

const TICK_MS = 60_000;
/** Le premier tour attend que le démarrage (catalogue, index) soit passé. */
const START_DELAY_MS = 3 * 60_000;
/** Le palier 1 relu toutes les dix minutes ; le plan complet toutes les six heures. */
const WATCH_EVERY_MS = 10 * 60_000;
const PLAN_EVERY_MS = 6 * 3600_000;
/** Nos éléments en file au service, au plus. */
export const MAX_PENDING = 2;
/** La file du service entière, au-delà de laquelle on n'ajoute rien. */
export const MAX_SERVICE_PENDING = 3;
/** Les éléments vérifiés par tour (déjà faits, écartés…) avant d'en trouver un à commander. */
const CHECKS_PER_TICK = 20;
/** La relecture lente des éléments finis. */
const RECHECK_AFTER_MS = 7 * 24 * 3600_000;
const RECHECKS_PER_TICK = 10;
/** Un échec, ou un écarté qui peut changer (sans fichier, sans distribution, hors des dossiers), revu après une semaine. */
const REOPEN_AFTER_MS = 7 * 24 * 3600_000;
const REOPENS_PER_TICK = 50;
/** Une erreur de réseau sur un élément (Jellyfin, TMDB injoignables) : l'élément est retenté dans l'heure. */
const TRANSIENT_RETRY_MS = 3600_000;
/** Une relecture du plan qui échoue : retentée après 15 min, 1 h, puis toutes les 6 h. */
const PLAN_BACKOFF_MS = [15 * 60_000, 3600_000, PLAN_EVERY_MS] as const;

const CONTROLS_KEY = "controls";
const PLANNED_KEY = "plannedAt";
const WATCHING_KEY = "watchingAt";
const PRIORITY_KEY = "priority";
/** La dernière relecture du plan tentée : `{ at, failures, error }` — `failures` remis à 0 au succès. */
const PLAN_TRIED_KEY = "planTried";
/** Les dossiers permis vus au dernier tour : changés, les « hors des dossiers » sont revus. */
const ROOTS_KEY = "libraryRoots";
/** L'écart de rang entre deux titres de la liste de priorité : une série tient dans 100 000 épisodes. */
const PRIORITY_RANK_STEP = 100_000;

export type ScanPhase = "off" | "starting" | "planning" | "running" | "waiting-playback" | "paused" | "unavailable" | "done";

export interface ScanControls {
  paused: ScanTier[];
  forced: ScanTier[];
}

interface Live {
  ticking: Promise<void> | null;
  started: boolean;
  timers: ReturnType<typeof setTimeout>[];
  phase: ScanPhase;
  playbackBy: string | null;
  lastTickAt: number;
  lastError: string | null;
  current: { itemId: string; title: string | null; progress: number } | null;
  lastBatchTier: ScanTier | null;
}

const LIVE_KEY = Symbol.for("cine-app.xrayScan");
const shared = globalThis as typeof globalThis & { [LIVE_KEY]?: Live };
const live: Live = (shared[LIVE_KEY] ??= {
  ticking: null,
  started: false,
  timers: [],
  phase: "starting",
  playbackBy: null,
  lastTickAt: 0,
  lastError: null,
  current: null,
  lastBatchTier: null,
});

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** `next dev` : la pile de développement partage `data/cine.db` — lu à l'appel (un test bascule `NODE_ENV`). */
const devServer = () => process.env.NODE_ENV === "development";

/**
 * Une erreur du service d'analyse lui-même : elle arrête le tour (le service est en panne pour tous les
 * éléments), à la différence d'une erreur de TMDB ou de Jellyfin propre à un élément.
 */
class XrayServiceError extends Error {
  constructor(cause: unknown) {
    super(errorText(cause), { cause });
    this.name = "XrayServiceError";
  }
}

async function service<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new XrayServiceError(error);
  }
}

export function readControls(): ScanControls {
  const c = readMeta<Partial<ScanControls>>(CONTROLS_KEY);
  const tiers = (v: unknown): ScanTier[] => (Array.isArray(v) ? SCAN_TIERS.filter((t) => v.includes(t)) : []);
  return { paused: tiers(c?.paused), forced: tiers(c?.forced) };
}

function writeControls(c: ScanControls): void {
  writeMeta(CONTROLS_KEY, { paused: [...new Set(c.paused)].sort(), forced: [...new Set(c.forced)].sort() });
}

// ─── Le plan ─────────────────────────────────────────────────────────────────

/**
 * La relecture complète. La liste des comptes (palier 1) et la bibliothèque sont lues ensemble mais
 * indépendamment (`allSettled`) : la première est appliquée dès qu'elle est lue, même si la seconde
 * échoue ; sans elle, le plan garde le palier 1 retenu (`storedWatching`). Une bibliothèque illisible
 * lève : le plan en place reste, et la relecture attend son tour (`PLAN_BACKOFF_MS`).
 */
async function refreshPlan(now: number): Promise<void> {
  live.phase = "planning";
  const [libraryRead, watchingRead] = await Promise.allSettled([readLibrary(), readWatching()]);
  if (watchingRead.status === "fulfilled") setWatching(watchingRead.value, now - NEW_WINDOW_MS);
  else logError("xray/scan-watching", watchingRead.reason);
  writeMeta(WATCHING_KEY, now);
  if (libraryRead.status === "rejected") throw libraryRead.reason;
  const plan = buildPlan(libraryRead.value, watchingRead.status === "fulfilled" ? watchingRead.value : storedWatching(), now);
  const generation = now;
  for (let i = 0; i < plan.length; i += 500) {
    upsertPlanSlice(plan.slice(i, i + 500), generation);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // Une bibliothèque lue vide (Jellyfin qui répond une liste vide) n'efface pas tout le suivi.
  const removed = plan.length > 0 ? dropUnseen(generation) : 0;
  writeMeta(PLANNED_KEY, now);
  // La liste de priorité réappliquée : les épisodes arrivés depuis dans une série choisie y entrent.
  await applyPriority().catch((error: unknown) => logError("xray/scan-priority", error));
  const counts = tierCounts();
  const of = (t: ScanTier) => counts.find((c) => c.tier === t)?.total ?? 0;
  taskLog("xray", "plan relu", {
    priorité: of(0),
    palier1: of(1),
    palier2: of(2),
    palier3: of(3),
    faits: counts.reduce((s, c) => s + c.done, 0),
    écartés: counts.reduce((s, c) => s + c.excluded, 0),
    retirés: removed,
  });
}

interface PlanTried {
  at: number;
  failures: number;
  error: string | null;
}

export const planBackoffMs = (failures: number): number => PLAN_BACKOFF_MS[Math.min(Math.max(failures, 1), PLAN_BACKOFF_MS.length) - 1];

/**
 * Le plan relu s'il est dû (vide, ou six heures passées) et que le dernier échec a assez attendu ;
 * sinon le palier 1 s'il a dix minutes. Rend l'incident à afficher (relecture en échec), ou `null`.
 */
async function refreshIfDue(now: number): Promise<string | null> {
  const plannedAt = readMeta<number>(PLANNED_KEY) ?? 0;
  if (planSize() === 0 || now - plannedAt >= PLAN_EVERY_MS) {
    const tried = readMeta<PlanTried>(PLAN_TRIED_KEY);
    const failures = tried && typeof tried.failures === "number" ? tried.failures : 0;
    if (failures > 0 && tried && now - tried.at < planBackoffMs(failures)) return tried.error;
    try {
      await refreshPlan(now);
      writeMeta(PLAN_TRIED_KEY, { at: now, failures: 0, error: null } satisfies PlanTried);
      return null;
    } catch (error) {
      const text = errorText(error);
      writeMeta(PLAN_TRIED_KEY, { at: now, failures: failures + 1, error: text } satisfies PlanTried);
      logError("xray/scan-plan", error, { failures: failures + 1 });
      return text;
    }
  }
  if (now - (readMeta<number>(WATCHING_KEY) ?? 0) >= WATCH_EVERY_MS) await refreshWatching(now).catch((error: unknown) => logError("xray/scan-watching", error));
  return null;
}

async function refreshWatching(now: number): Promise<void> {
  // La date d'abord : une liste des comptes illisible est retentée dans dix minutes, pas à chaque tour.
  writeMeta(WATCHING_KEY, now);
  setWatching(await readWatching(), now - NEW_WINDOW_MS);
}

/**
 * Le scan s'arrête-t-il pendant une lecture ? Non par défaut (consigne du propriétaire, 10/11/2026) :
 * l'analyse ne gêne qu'un transcodage, et le service s'en écarte déjà — il rend l'iGPU dès que Jellyfin
 * transcode, ses ordres partent en `low` derrière celui d'un spectateur, et son conteneur pèse moins que
 * Jellyfin quand le processeur est disputé (`cpu_shares`). Attendre la fin de chaque lecture laissait la
 * bibliothèque des semaines de plus. `XRAY_SCAN_DURING_PLAYBACK=false` (`.env`) rétablit l'attente pour
 * une machine trop juste. Relu à chaque tour.
 */
export function scanWaitsForPlayback(): boolean {
  return process.env.XRAY_SCAN_DURING_PLAYBACK?.trim().toLowerCase() === "false";
}

/** Les dossiers permis ont changé (`XRAY_LIBRARY_ROOTS`) : ce qui était « hors des dossiers » est revu. */
function followLibraryRoots(): void {
  const roots = libraryRoots().join(",");
  const seen = readMeta<string>(ROOTS_KEY);
  if (seen === roots) return;
  const reopened = seen === null ? 0 : reopenOutsideLibrary();
  writeMeta(ROOTS_KEY, roots);
  if (reopened > 0) taskLog("xray", "dossiers permis changés", { revus: reopened });
}

// ─── Ce qui est en file ──────────────────────────────────────────────────────

type ItemStats = XrayItemState & { stats?: { seconds?: number; realtime?: number } | null };

const computeOf = (state: ItemStats): number | null => {
  const s = state.stats?.seconds;
  return typeof s === "number" && s > 0 ? s : null;
};

/**
 * Nos éléments en file : finis, en échec, oubliés par le service, ou celui qui tourne. `waiting` : ceux
 * que le service dit encore en attente (pas celui qui tourne) — le reste de sa file `pending` est à
 * d'autres, les commandes des spectateurs. Un état illisible ne compte pas comme le nôtre : mieux vaut
 * croire à une commande de spectateur de trop que passer devant l'une d'elles.
 */
async function followInflight(now: number): Promise<{ inflight: number; waiting: number }> {
  let inflight = 0;
  let waiting = 0;
  live.current = null;
  for (const row of rowsWithStatus("queued")) {
    let state: ItemStats | null;
    try {
      state = (await xray.itemStatus(row.itemId)) as ItemStats | null;
    } catch {
      inflight++;
      continue;
    }
    if (!state || (row.etag && state.etag !== row.etag)) {
      // Oublié par le service, ou une autre version commandée entre-temps : à revérifier.
      markRow(row.itemId, { status: "pending", checkedAt: now });
    } else if (state.status === "done") {
      markRow(row.itemId, { status: "done", finishedAt: now, checkedAt: now, computeS: computeOf(state), error: null });
    } else if (state.status === "failed") {
      markRow(row.itemId, { status: "failed", finishedAt: now, checkedAt: now, error: (state.error ?? "échec").slice(0, 300) });
    } else {
      inflight++;
      if (state.status === "queued") waiting++;
      if (state.status === "running") live.current = { itemId: row.itemId, title: row.title, progress: typeof state.progress === "number" ? state.progress : 0 };
    }
  }
  return { inflight, waiting };
}

type Prepared = "queued" | "done" | "excluded" | "failed";

/**
 * Un élément : déjà fait, à rattacher, à écarter, ou à commander — en `normal` pour la liste de priorité
 * (elle passe devant les `low` du fond, jamais devant le `high` d'un spectateur), en `low` sinon.
 */
async function prepare(row: ScanRow, now: number): Promise<Prepared> {
  const priority = row.tier === 0 ? "normal" : "low";
  const target = await analysisTarget(row.itemId);
  if (!target) {
    markRow(row.itemId, { status: "excluded", reason: "no-file", checkedAt: now });
    return "excluded";
  }
  // Seulement les dossiers des films et des séries — jamais les téléchargements, les seeds, les livres
  // (consigne du propriétaire) : vérifié sur le chemin réel, pas déduit de la liste de Jellyfin.
  if (!isLibraryPath(target.path)) {
    markRow(row.itemId, { status: "excluded", reason: "outside-library", checkedAt: now });
    return "excluded";
  }
  if (!target.tmdb) {
    markRow(row.itemId, { status: "excluded", reason: "no-cast", checkedAt: now });
    return "excluded";
  }
  const state = (await service(() => xray.itemStatus(target.itemId))) as ItemStats | null;
  // Un échec du service au même fichier : retenu tel quel à la découverte ; relancé quand l'élément
  // revient d'un échec déjà retenu (`reopenStale` garde son `error`) — « un ordre en échec est
  // relancé » (contrat). Avant, la relance hebdomadaire relisait l'échec et ne commandait rien.
  const relaunch = state?.status === "failed" && !!row.error;
  if (state && state.etag === target.etag && !relaunch) {
    if (state.status === "done") {
      markRow(row.itemId, { status: "done", etag: target.etag, checkedAt: now, finishedAt: now, computeS: computeOf(state), error: null });
      return "done";
    }
    if (state.status === "failed") {
      markRow(row.itemId, { status: "failed", etag: target.etag, checkedAt: now, finishedAt: now, error: (state.error ?? "échec").slice(0, 300) });
      return "failed";
    }
    // Déjà en file (la commande d'un spectateur, ou la nôtre en `low` avant que l'administrateur ne le
    // mette en priorité) : compte dans notre avance. Une commande en double ne fait que remonter la
    // priorité (contrat) — d'où la nouvelle commande pour la liste de priorité.
    if (row.tier === 0) {
      const raised = await jobFor(target, priority);
      if (raised) await service(() => xray.enqueue(raised.job));
    }
    markRow(row.itemId, { status: "queued", etag: target.etag, orderedAt: now, checkedAt: now });
    return "queued";
  }
  const built = await jobFor(target, priority);
  if (!built) {
    markRow(row.itemId, { status: "excluded", reason: "no-cast", checkedAt: now });
    return "excluded";
  }
  // Fini pour un autre fichier de même durée : rattaché, pas réanalysé (consigne du 09/11/2026).
  const durationS = target.durationS;
  if (state && state.status === "done" && durationS && keepsAnalysis(target.itemId, state, durationS)) {
    // À la priorité du palier : la liste de priorité ne retombe pas en `low` quand le service réanalyse.
    const outcome = await service(() => rebindAnalysis(built.job, durationS, priority));
    if (outcome !== "queued") {
      markRow(row.itemId, { status: "done", reason: outcome === "rebound" ? "rebound" : "same-duration", etag: target.etag, checkedAt: now, finishedAt: now, error: null });
      return "done";
    }
    markRow(row.itemId, { status: "queued", etag: target.etag, orderedAt: now, checkedAt: now });
    return "queued";
  }
  try {
    const answer = await xray.enqueue(built.job);
    recordFileVersion(target.itemId, target.etag, target.durationS);
    if (answer.status === "done") {
      markRow(row.itemId, { status: "done", etag: target.etag, checkedAt: now, finishedAt: now, error: null });
      return "done";
    }
    markRow(row.itemId, { status: "queued", etag: target.etag, orderedAt: now, checkedAt: now, error: null });
    return "queued";
  } catch (error) {
    // Refusé par le service (chemin hors de la médiathèque, champ invalide) : un échec de cet élément,
    // pas du tour.
    if (error instanceof HttpError && error.status === 400) {
      markRow(row.itemId, { status: "failed", etag: target.etag, checkedAt: now, finishedAt: now, error: errorText(error) });
      return "failed";
    }
    throw new XrayServiceError(error);
  }
}

/** La relecture lente : un élément fini dont le fichier a changé d'`ETag` repasse à vérifier. */
async function recheckDone(now: number): Promise<number> {
  let reopened = 0;
  for (const row of staleDone(now - RECHECK_AFTER_MS, RECHECKS_PER_TICK)) {
    const target = await analysisTarget(row.itemId).catch(() => undefined);
    if (target === undefined) break; // Jellyfin injoignable : au tour suivant.
    // Les échecs ne passent plus par ici : `reopenStale` les rouvre chaque semaine, sans attendre que
    // toute la bibliothèque soit finie.
    if (target && row.etag && target.etag !== row.etag) {
      markRow(row.itemId, { status: "pending", checkedAt: now });
      reopened++;
    } else {
      markRow(row.itemId, { checkedAt: now });
    }
  }
  return reopened;
}

// ─── Le tour ─────────────────────────────────────────────────────────────────

/** Rend l'incident à afficher sans que le tour ait échoué (une relecture du plan en échec), ou `null`. */
async function runTick(now: number): Promise<string | null> {
  live.lastTickAt = now;
  if (!xrayConfigured()) {
    live.phase = "off";
    return null;
  }
  // Rien que la base : les écartés et les échecs à revoir, les dossiers permis qui ont changé.
  followLibraryRoots();
  reopenStale(now - REOPEN_AFTER_MS, REOPENS_PER_TICK);

  const controls = readControls();
  const active = SCAN_TIERS.filter((t) => !controls.paused.includes(t));
  if (active.length === 0) {
    // Tout en pause : aucune lecture, ni de la bibliothèque, ni des comptes, ni du service.
    live.phase = "paused";
    live.playbackBy = null;
    return null;
  }
  const { inflight, waiting } = await followInflight(now);
  let allowed = active;
  const { wait: playing, signal } = await mustWaitForPlayback(now);
  const wait = playing && scanWaitsForPlayback();
  if (wait) {
    // La liste de priorité est une demande explicite de l'administrateur : elle compte comme forcée —
    // tant qu'elle a du travail ; vide, l'état dit qu'on attend la fin de la lecture.
    const before = tierCounts().find((c) => c.tier === 0);
    const priorityWork = !!before && before.total - before.done - before.failed > 0;
    allowed = active.filter((t) => (t === 0 && priorityWork) || controls.forced.includes(t));
    if (allowed.length === 0) {
      // Pendant une lecture sans rien de forcé, la bibliothèque et les comptes ne sont pas relus non plus.
      live.phase = "waiting-playback";
      live.playbackBy = signal.by;
      return null;
    }
  }
  const planIssue = await refreshIfDue(now);
  if (planSize() === 0) {
    live.phase = "unavailable";
    return planIssue;
  }
  live.playbackBy = null;
  live.phase = "running";

  let slots = MAX_PENDING - inflight;
  let feed: readonly ScanTier[] = allowed;
  if (slots > 0) {
    const health = await xray.health();
    const pending = health.queue?.pending ?? 0;
    slots = Math.min(slots, MAX_SERVICE_PENDING - pending);
    if (!live.current && health.queue?.running) {
      const row = getRow(health.queue.running);
      live.current = { itemId: health.queue.running, title: row?.title ?? null, progress: 0 };
    }
    // La liste de priorité part en `normal`, comme l'épisode suivant d'un spectateur (`orders.ts`) : à
    // priorité égale le service sert dans l'ordre d'arrivée, et une commande à nous passée avant serait
    // servie avant la sienne. Elle n'est donc nourrie que lorsque la file du service ne contient rien
    // d'autre que nos propres commandes ; sinon rien ne part du tout ce tour-ci — pas même le fond en
    // `low`, qui prendrait les places que la liste de priorité attend (revue du 09/11/2026).
    if (slots > 0 && allowed.includes(0) && pending - waiting > 0 && nextPending([0], 1).length > 0) {
      feed = [];
      slots = 0;
    }
  }
  const ordered: ScanRow[] = [];
  if (slots > 0) {
    for (const row of nextPending(feed, CHECKS_PER_TICK)) {
      if (slots <= 0) break;
      let outcome: Prepared;
      try {
        outcome = await prepare(row, now);
      } catch (error) {
        // Le service en panne : le tour s'arrête, tous les éléments en pâtiraient.
        if (error instanceof XrayServiceError) throw error.cause ?? error;
        // Propre à cet élément : un échec, et la file continue. Une réponse d'erreur (TMDB, Jellyfin) est
        // retentée dans une semaine ; une erreur de réseau dans l'heure, et le tour s'arrête là — une
        // panne de Jellyfin ne met pas vingt éléments en échec par minute.
        const answered = error instanceof HttpError;
        markRow(row.itemId, { status: "failed", error: errorText(error), finishedAt: now, checkedAt: answered ? now : now - REOPEN_AFTER_MS + TRANSIENT_RETRY_MS });
        logError("xray/scan-item", error, { itemId: row.itemId });
        if (!answered) break;
        continue;
      }
      if (outcome === "queued") {
        ordered.push(row);
        slots--;
      }
    }
  }
  if (ordered.length > 0) {
    const tier = ordered[0].tier;
    taskLog("xray", live.lastBatchTier !== null && live.lastBatchTier !== tier ? `passage au palier ${tier} · lot commandé` : "lot commandé", {
      palier: tier,
      éléments: ordered.length,
      titres: ordered.map((r) => r.title),
      forcé: wait ? true : null,
    });
    live.lastBatchTier = tier;
  }

  // Une série dont tout le plan est traité est renommée une fois (10.30) : ses premiers épisodes profitent de la
  // mémoire construite par les suivants. Une panne n'arrête pas le tour.
  await relabelFinishedSeries().catch((error) => logError("xray/relabel", error));

  const counts = tierCounts();
  // Un palier forcé et vidé perd son forçage : une file continue (le palier 2) forcée pour toujours
  // passerait outre chaque lecture à venir.
  const left = (t: ScanTier) => {
    const c = counts.find((x) => x.tier === t);
    return c ? c.total - c.done - c.failed : 0;
  };
  // Relus juste avant d'écrire : un geste de l'administrateur pendant le tour (pause, forçage) n'est pas
  // écrasé par l'état lu au début ; seuls les paliers forcés au début, encore forcés et vidés, perdent
  // leur forçage.
  const fresh = readControls();
  const emptied = controls.forced.filter((t) => fresh.forced.includes(t) && left(t) === 0);
  if (emptied.length > 0) {
    writeControls({ paused: fresh.paused, forced: fresh.forced.filter((t) => !emptied.includes(t)) });
    taskLog("xray", "palier forcé terminé", { paliers: emptied.map(String) });
  }
  const remaining = counts.filter((c) => allowed.includes(c.tier)).reduce((s, c) => s + (c.total - c.done - c.failed), 0);
  // Plus rien à commander dans les paliers permis : le temps de la relecture lente des éléments finis.
  // Jamais pendant une lecture : la relecture est du travail de fond comme un autre.
  if (remaining === 0 && inflight === 0 && !wait) {
    const reopened = await recheckDone(now);
    // « À jour » seulement si aucun palier en pause n'a encore du travail : sinon, c'est la pause qui
    // retient la suite, et l'état le dit.
    const pausedWork = fresh.paused.some((t) => left(t) > 0);
    live.phase = reopened > 0 ? "running" : pausedWork ? "paused" : "done";
  } else if (remaining === 0 && inflight === 0) {
    live.phase = "waiting-playback";
    live.playbackBy = signal.by;
  }
  return planIssue;
}

/** Les séries renommées : `seriesId → nombre d'épisodes finis` au moment du renommage. */
const RELABELED_KEY = "relabeled-series";
/** Au plus tant de séries renommées par tour : le service les sert entre deux tronçons, par lots bornés. */
export const RELABELS_PER_TICK = 3;

/**
 * Renommer une série dont tout le plan est traité (consigne du propriétaire, 10/11/2026) : une fois, par
 * `POST /series/{id}/relabel` dans l'ordre des épisodes — le service refait regroupement et noms sans relire
 * les fichiers, avec la mémoire de toute la série. Refait si de nouveaux épisodes ont été finis depuis.
 */
async function relabelFinishedSeries(): Promise<number> {
  const done = readMeta<Record<string, number>>(RELABELED_KEY) ?? {};
  let n = 0;
  for (const s of finishedSeries()) {
    if (n >= RELABELS_PER_TICK) break;
    if (done[s.seriesId] === s.done) continue;
    // Retenu avant l'appel : un service qui refuse (version d'avant 10.30) n'est pas redemandé à chaque tour.
    done[s.seriesId] = s.done;
    writeMeta(RELABELED_KEY, done);
    n++;
    await service(() => xray.relabelSeries(s.seriesId, s.itemIds));
    taskLog("xray", "série renommée", { série: s.name, épisodes: s.done });
  }
  return n;
}

/** Un tour — jamais deux à la fois : un tour en cours est rendu à qui en demande un autre. */
export function scanTick(now = Date.now()): Promise<void> {
  if (devServer()) return Promise.resolve();
  if (live.ticking) return live.ticking;
  live.ticking = runTick(now)
    .then((issue) => {
      live.lastError = issue;
    })
    .catch((error: unknown) => {
      live.lastError = errorText(error);
      if (live.phase === "planning" || live.phase === "running") live.phase = "unavailable";
      logError("xray/scan", error);
    })
    .finally(() => {
      live.ticking = null;
    });
  return live.ticking;
}

/** Démarrage du serveur : premier tour après le démarrage, puis chaque minute. */
export function startXrayScheduler(): void {
  if (live.started || devServer()) return;
  live.started = true;
  const first = setTimeout(() => void scanTick(), START_DELAY_MS);
  first.unref?.();
  const every = setInterval(() => void scanTick(), TICK_MS);
  every.unref?.();
  live.timers.push(first, every);
}

// ─── Les gestes de l'administrateur ──────────────────────────────────────────

export type ScanAction = "run" | "pause" | "resume" | "unforce";

/**
 * « Lancer maintenant » (`run`) : le palier est repris et forcé — nourri même pendant une lecture — et
 * un tour part tout de suite. « Mettre en pause » : plus rien de neuf pour ce palier (le forçage tombe).
 * « Reprendre » : la pause tombe, le palier attend de nouveau qu'on ne regarde rien. Sans palier : tous.
 */
export async function scanAction(action: ScanAction, tier: ScanTier | null): Promise<void> {
  const tiers = tier !== null ? [tier] : [...SCAN_TIERS];
  const c = readControls();
  if (action === "run") writeControls({ paused: c.paused.filter((t) => !tiers.includes(t)), forced: [...c.forced, ...tiers] });
  else if (action === "pause") writeControls({ paused: [...c.paused, ...tiers], forced: c.forced.filter((t) => !tiers.includes(t)) });
  else if (action === "resume") writeControls({ paused: c.paused.filter((t) => !tiers.includes(t)), forced: c.forced });
  else writeControls({ paused: c.paused, forced: c.forced.filter((t) => !tiers.includes(t)) });
  taskLog("xray", action === "run" ? "lancé à la main" : action === "pause" ? "mis en pause" : action === "resume" ? "repris" : "forçage retiré", {
    paliers: tiers.map(String),
  });
  if (action === "run" || action === "resume") {
    // Le tour part sans être attendu au-delà de quelques secondes : la page garde la main.
    await Promise.race([scanTick(), new Promise<void>((resolve) => setTimeout(resolve, 5000).unref?.())]);
  } else if (action === "pause" && readControls().paused.length === SCAN_TIERS.length) {
    live.phase = "paused";
  }
}

// ─── La liste de priorité ────────────────────────────────────────────────────

/** Un film, ou une série entière, que l'administrateur a fait passer devant tout le reste. */
export interface PriorityEntry {
  id: string;
  kind: "Movie" | "Series";
  title: string;
  addedAt: number;
}

export function readPriority(): PriorityEntry[] {
  const list = readMeta<PriorityEntry[]>(PRIORITY_KEY);
  return Array.isArray(list) ? list.filter((e) => e && typeof e.id === "string" && (e.kind === "Movie" || e.kind === "Series")) : [];
}

/** Chaque titre de la liste relu (un épisode arrivé depuis y entre), à son rang. */
async function applyPriority(): Promise<void> {
  const list = readPriority();
  for (let i = 0; i < list.length; i++) {
    const found = await readPriorityTitle(list[i].id);
    if (found && !found.animation) setPriorityRows(list[i].id, found.rows, (i + 1) * PRIORITY_RANK_STEP);
  }
}

export type PrioritizeRefusal = "not-found" | "animation";

/**
 * « Analyser en priorité » : un film, ou tous les épisodes d'une série dans l'ordre (saison par saison,
 * les spéciaux à la fin), au palier 0 — vérifiés comme les autres (déjà fait, durée égale, dossiers
 * permis, distribution), commandés en `normal`, nourris même pendant une lecture, deux d'avance au plus.
 * L'animation reste écartée : le titre est refusé (`animation`) et la page le dit. Retenu dans `cine.db`.
 */
export async function prioritizeTitle(itemId: string, now = Date.now()): Promise<PrioritizeRefusal | null> {
  const id = itemId.toLowerCase();
  const found = await readPriorityTitle(id);
  if (!found) return "not-found";
  if (found.animation) return "animation";
  const list = readPriority();
  const at = list.findIndex((e) => e.id === id);
  const entry: PriorityEntry = { id, kind: found.kind, title: found.title, addedAt: at >= 0 ? list[at].addedAt : now };
  if (at < 0) list.push(entry);
  writeMeta(PRIORITY_KEY, list);
  setPriorityRows(id, found.rows, (list.findIndex((e) => e.id === id) + 1) * PRIORITY_RANK_STEP);
  taskLog("xray", "mis en priorité", { titre: found.title, éléments: found.rows.length });
  // Le tour part tout de suite, sans être attendu au-delà de quelques secondes.
  await Promise.race([scanTick(), new Promise<void>((resolve) => setTimeout(resolve, 5000).unref?.())]);
  return null;
}

/** Retiré de la liste : ses éléments retrouvent le palier de leur date ; ce qui est fait reste fait. */
export function unprioritizeTitle(itemId: string, now = Date.now()): boolean {
  const id = itemId.toLowerCase();
  const list = readPriority();
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return false;
  writeMeta(PRIORITY_KEY, next);
  clearPriorityRows(id, now - NEW_WINDOW_MS);
  // Le palier 1 relu au tour suivant : un élément qu'un compte regarde y remonte.
  writeMeta(WATCHING_KEY, 0);
  taskLog("xray", "retiré de la priorité", { titre: list.find((e) => e.id === id)?.title });
  return true;
}

// ─── L'état, pour la page ────────────────────────────────────────────────────

export interface ScanTierStatus extends Omit<TierCounts, "remainingS"> {
  remainingHours: number;
  /** Temps de calcul restant (s) à la vitesse mesurée, `null` sans mesure. */
  etaS: number | null;
  paused: boolean;
  forced: boolean;
}

export interface XrayScanStatus {
  configured: boolean;
  phase: ScanPhase;
  playbackBy: string | null;
  plannedAt: number | null;
  lastTickAt: number;
  lastError: string | null;
  current: Live["current"];
  /** × temps réel, mesuré sur les derniers éléments finis. */
  speed: number | null;
  tiers: ScanTierStatus[];
  /** La liste de priorité (palier 0) : sa pause, et chaque titre avec son avancement. */
  priority: {
    paused: boolean;
    items: (PriorityEntry & { total: number; done: number; queued: number; failed: number; excluded: number; etaS: number | null })[];
  };
  etaAllS: number | null;
  errors: { itemId: string; title: string; error: string; at: number }[];
}

export function xrayScanStatus(): XrayScanStatus {
  const configured = xrayConfigured();
  const counts = tierCounts();
  const controls = readControls();
  const speed = analysisSpeed(speedSamples());
  const tiers = counts.filter((c) => c.tier !== 0).map(({ remainingS, ...c }) => ({
    ...c,
    remainingHours: remainingS / 3600,
    etaS: etaSeconds(remainingS, speed),
    paused: controls.paused.includes(c.tier),
    forced: controls.forced.includes(c.tier),
  }));
  const remaining = counts.reduce((s, c) => s + c.remainingS, 0);
  const perTitle = priorityCounts();
  const priority = {
    paused: controls.paused.includes(0),
    items: readPriority().map((entry) => {
      const c = perTitle.get(entry.id);
      return {
        ...entry,
        total: c?.total ?? 0,
        done: c?.done ?? 0,
        queued: c?.queued ?? 0,
        failed: c?.failed ?? 0,
        excluded: c?.excluded ?? 0,
        etaS: etaSeconds(c?.remainingS ?? 0, speed),
      };
    }),
  };
  return {
    configured,
    phase: configured ? (live.phase === "off" ? "starting" : live.phase) : "off",
    playbackBy: live.playbackBy,
    plannedAt: readMeta<number>(PLANNED_KEY),
    lastTickAt: live.lastTickAt,
    lastError: live.lastError,
    current: live.current,
    speed: speed === null ? null : Math.round(speed * 10) / 10,
    tiers,
    priority,
    etaAllS: etaSeconds(remaining, speed),
    errors: lastErrors(10),
  };
}

export const __testing = {
  live,
  reset(): void {
    for (const t of live.timers) clearTimeout(t);
    Object.assign(live, { ticking: null, started: false, timers: [], phase: "starting", playbackBy: null, lastTickAt: 0, lastError: null, current: null, lastBatchTier: null });
  },
};
