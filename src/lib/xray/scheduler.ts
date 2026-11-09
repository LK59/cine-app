import { HttpError } from "@/lib/http";
import { xray, xrayConfigured, type XrayItemState } from "@/lib/clients/xray";
import { logError } from "@/lib/logger";
import { taskLog } from "@/lib/taskLog";
import { mustWaitForPlayback } from "@/lib/repliques/playbackActivity";
import { analysisTarget } from "./cast";
import { jobFor, keepsAnalysis, rebindAnalysis } from "./rebind";
import { analysisSpeed, buildPlan, etaSeconds, isLibraryPath, NEW_WINDOW_MS, SCAN_TIERS, type ScanTier } from "./scanPlan";
import { readLibrary, readWatching } from "./scanSources";
import {
  dropUnseen,
  getRow,
  lastErrors,
  markRow,
  nextPending,
  planSize,
  readMeta,
  recordFileVersion,
  rowsWithStatus,
  setWatching,
  speedSamples,
  staleDone,
  tierCounts,
  upsertPlanSlice,
  writeMeta,
  type ScanRow,
  type TierCounts,
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

const CONTROLS_KEY = "controls";
const PLANNED_KEY = "plannedAt";
const WATCHING_KEY = "watchingAt";

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

export function readControls(): ScanControls {
  const c = readMeta<Partial<ScanControls>>(CONTROLS_KEY);
  const tiers = (v: unknown): ScanTier[] => (Array.isArray(v) ? SCAN_TIERS.filter((t) => v.includes(t)) : []);
  return { paused: tiers(c?.paused), forced: tiers(c?.forced) };
}

function writeControls(c: ScanControls): void {
  writeMeta(CONTROLS_KEY, { paused: [...new Set(c.paused)].sort(), forced: [...new Set(c.forced)].sort() });
}

// ─── Le plan ─────────────────────────────────────────────────────────────────

async function refreshPlan(now: number): Promise<void> {
  live.phase = "planning";
  const [library, watching] = await Promise.all([readLibrary(), readWatching()]);
  const plan = buildPlan(library, watching, now);
  const generation = now;
  for (let i = 0; i < plan.length; i += 500) {
    upsertPlanSlice(plan.slice(i, i + 500), generation);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  // Une bibliothèque lue vide (Jellyfin qui répond une liste vide) n'efface pas tout le suivi.
  const removed = plan.length > 0 ? dropUnseen(generation) : 0;
  writeMeta(PLANNED_KEY, now);
  writeMeta(WATCHING_KEY, now);
  const counts = tierCounts();
  taskLog("xray", "plan relu", {
    palier1: counts[0].total,
    palier2: counts[1].total,
    palier3: counts[2].total,
    faits: counts.reduce((s, c) => s + c.done, 0),
    écartés: counts.reduce((s, c) => s + c.excluded, 0),
    retirés: removed,
  });
}

async function refreshWatching(now: number): Promise<void> {
  setWatching(await readWatching(), now - NEW_WINDOW_MS);
  writeMeta(WATCHING_KEY, now);
}

// ─── Ce qui est en file ──────────────────────────────────────────────────────

type ItemStats = XrayItemState & { stats?: { seconds?: number; realtime?: number } | null };

const computeOf = (state: ItemStats): number | null => {
  const s = state.stats?.seconds;
  return typeof s === "number" && s > 0 ? s : null;
};

/** Nos éléments en file : finis, en échec, oubliés par le service, ou celui qui tourne. */
async function followInflight(now: number): Promise<number> {
  let inflight = 0;
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
      if (state.status === "running") live.current = { itemId: row.itemId, title: row.title, progress: typeof state.progress === "number" ? state.progress : 0 };
    }
  }
  return inflight;
}

type Prepared = "queued" | "done" | "excluded" | "failed";

/** Un élément : déjà fait, à rattacher, à écarter, ou à commander en `low`. */
async function prepare(row: ScanRow, now: number): Promise<Prepared> {
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
  const state = (await xray.itemStatus(target.itemId)) as ItemStats | null;
  if (state && state.etag === target.etag) {
    if (state.status === "done") {
      markRow(row.itemId, { status: "done", etag: target.etag, checkedAt: now, finishedAt: now, computeS: computeOf(state), error: null });
      return "done";
    }
    if (state.status === "failed") {
      markRow(row.itemId, { status: "failed", etag: target.etag, checkedAt: now, finishedAt: now, error: (state.error ?? "échec").slice(0, 300) });
      return "failed";
    }
    // Déjà en file (la commande d'un spectateur) : compte dans notre avance.
    markRow(row.itemId, { status: "queued", etag: target.etag, orderedAt: now, checkedAt: now });
    return "queued";
  }
  const built = await jobFor(target, "low");
  if (!built) {
    markRow(row.itemId, { status: "excluded", reason: "no-cast", checkedAt: now });
    return "excluded";
  }
  // Fini pour un autre fichier de même durée : rattaché, pas réanalysé (consigne du 09/11/2026).
  if (state && state.status === "done" && target.durationS && keepsAnalysis(target.itemId, state, target.durationS)) {
    const outcome = await rebindAnalysis(built.job, target.durationS);
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
    throw error;
  }
}

/** La relecture lente : un élément fini dont le fichier a changé d'`ETag` repasse à vérifier. */
async function recheckDone(now: number): Promise<number> {
  let reopened = 0;
  for (const row of staleDone(now - RECHECK_AFTER_MS, RECHECKS_PER_TICK)) {
    const target = await analysisTarget(row.itemId).catch(() => undefined);
    if (target === undefined) break; // Jellyfin injoignable : au tour suivant.
    if (target && row.etag && target.etag !== row.etag) {
      markRow(row.itemId, { status: "pending", checkedAt: now });
      reopened++;
    } else if (row.status === "failed") {
      // Un échec est retenté une fois par semaine : le service a pu être corrigé.
      markRow(row.itemId, { status: "pending", checkedAt: now });
      reopened++;
    } else {
      markRow(row.itemId, { checkedAt: now });
    }
  }
  return reopened;
}

// ─── Le tour ─────────────────────────────────────────────────────────────────

async function runTick(now: number): Promise<void> {
  live.lastTickAt = now;
  if (!xrayConfigured()) {
    live.phase = "off";
    return;
  }
  const plannedAt = readMeta<number>(PLANNED_KEY) ?? 0;
  if (planSize() === 0 || now - plannedAt >= PLAN_EVERY_MS) await refreshPlan(now);
  else if (now - (readMeta<number>(WATCHING_KEY) ?? 0) >= WATCH_EVERY_MS) await refreshWatching(now).catch((error: unknown) => logError("xray/scan-watching", error));

  const inflight = await followInflight(now);
  const controls = readControls();
  const active = SCAN_TIERS.filter((t) => !controls.paused.includes(t));
  if (active.length === 0) {
    live.phase = "paused";
    live.playbackBy = null;
    return;
  }
  let allowed = active;
  const { wait, signal } = await mustWaitForPlayback(now);
  if (wait) {
    allowed = active.filter((t) => controls.forced.includes(t));
    if (allowed.length === 0) {
      live.phase = "waiting-playback";
      live.playbackBy = signal.by;
      return;
    }
  }
  live.playbackBy = null;
  live.phase = "running";

  let slots = MAX_PENDING - inflight;
  if (slots > 0) {
    const health = await xray.health();
    slots = Math.min(slots, MAX_SERVICE_PENDING - (health.queue?.pending ?? 0));
    if (!live.current && health.queue?.running) {
      const row = getRow(health.queue.running);
      live.current = { itemId: health.queue.running, title: row?.title ?? null, progress: 0 };
    }
  }
  const ordered: ScanRow[] = [];
  if (slots > 0) {
    for (const row of nextPending(allowed, CHECKS_PER_TICK)) {
      if (slots <= 0) break;
      if ((await prepare(row, now)) === "queued") {
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

  const counts = tierCounts();
  // Un palier forcé et vidé perd son forçage : une file continue (le palier 2) forcée pour toujours
  // passerait outre chaque lecture à venir.
  const emptied = controls.forced.filter((t) => counts[t - 1].total - counts[t - 1].done - counts[t - 1].failed === 0);
  if (emptied.length > 0) {
    writeControls({ ...controls, forced: controls.forced.filter((t) => !emptied.includes(t)) });
    taskLog("xray", "palier forcé terminé", { paliers: emptied.map(String) });
  }
  const remaining = counts.filter((c) => allowed.includes(c.tier)).reduce((s, c) => s + (c.total - c.done - c.failed), 0);
  // Plus rien à commander dans les paliers permis : le temps de la relecture lente des éléments finis.
  if (remaining === 0 && inflight === 0) {
    const reopened = await recheckDone(now);
    live.phase = reopened > 0 ? "running" : "done";
  }
}

/** Un tour — jamais deux à la fois : un tour en cours est rendu à qui en demande un autre. */
export function scanTick(now = Date.now()): Promise<void> {
  if (live.ticking) return live.ticking;
  live.ticking = runTick(now)
    .then(() => {
      live.lastError = null;
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
  if (live.started) return;
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
  const tiers = tier ? [tier] : [...SCAN_TIERS];
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
  etaAllS: number | null;
  errors: { itemId: string; title: string; error: string; at: number }[];
}

export function xrayScanStatus(): XrayScanStatus {
  const configured = xrayConfigured();
  const counts = tierCounts();
  const controls = readControls();
  const speed = analysisSpeed(speedSamples());
  const tiers = counts.map(({ remainingS, ...c }) => ({
    ...c,
    remainingHours: remainingS / 3600,
    etaS: etaSeconds(remainingS, speed),
    paused: controls.paused.includes(c.tier),
    forced: controls.forced.includes(c.tier),
  }));
  const remaining = counts.reduce((s, c) => s + c.remainingS, 0);
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
