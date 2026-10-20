import { budgetOf, cacheReadRate, costOf } from "./pricing";
import { config } from "@/lib/config";
import { logError } from "@/lib/logger";
import { genAvailable, genSettings, providerFor, ProviderError, type GenSettings, type TranslationProvider, type Usage } from "./providers";
import { GLOSSARY_SCHEMA, GLOSSARY_USER, batchSystem, batchUser, glossarySystem, parseGlossary, sourceBlock, stablePrefix, type Glossary } from "./prompts";
import { LineSplitter, fitLines, maxLinesFor, parseReply, parseReplyLine, sameShape, validateBatch } from "./validate";
import { matchSourceCase } from "./textCase";
import { nextBatch, activeViewers, anchorIndex, seekBatch, type Plan, type Viewer } from "./scheduler";
import { cuesDb, jobsDb, sameFile, spendDb, type JobRow } from "./store";
import { fetchSourceCues, isFullTrack, sourceHash, type SourceCandidate } from "./source";
import { readFinal, writeFinal } from "./files";
import { logGen } from "./log";
import { externalSubtitlePaths, fetchItemSource, isOurStream, nameTaken, refreshItem, uploadSubtitle, streamTextHash, deleteSubtitle } from "./present";
import { twoLetter } from "./languages";

/**
 * Le moteur des sous-titres générés (DECISIONS.md §69) : un seul par processus, qui fait avancer
 * toutes les tâches à la fois.
 *
 * - **Concurrence bornée** : trois requêtes au fournisseur à la fois, toutes tâches confondues —
 *   et **une seule par tâche** : chaque requête d'une tâche relit le même préfixe en cache (consignes,
 *   glossaire, texte source complet), et un cache n'est lisible qu'une fois la première réponse
 *   commencée ; deux requêtes parallèles sur le même préfixe paieraient chacune l'écriture. Seule
 *   exceptions : le premier lot part pendant la préparation du glossaire, pour afficher vite ; les
 *   suivants attendent le glossaire, qui est ensuite figé (le changer casserait le préfixe). Et le
 *   **lot de saut** (`settleSeek`) : 8 répliques à la position d'un spectateur qui vient de sauter
 *   dans une zone vide, en parallèle du lot en cours — le cache est déjà écrit à ce stade, il relit
 *   le même préfixe à 0,1×. Au plus un par tâche ; il peut porter le total à `MAX_CONCURRENT + 1`.
 * - **Priorité aux spectateurs** : `nextBatch` (scheduler.ts) choisit le passage ; entre tâches,
 *   celle dont un spectateur manque d'avance passe d'abord.
 * - **En flux** : chaque ligne `id|traduction` est écrite dès qu'elle arrive, **provisoire** tant
 *   que le lot entier n'est pas validé (comptes, décalage) ; un lot refusé efface les siennes, et le
 *   nouvel essai les remplace chez le lecteur par leur rang.
 * - **Résilience** : lignes écrites dès réception ; erreurs passagères → nouvel essai à attente
 *   croissante, puis pause `unavailable` ; clé refusée → pause `config` ; crédit ou budget épuisé →
 *   pause `budget` ; reprise par un nouveau POST. Au démarrage, les tâches en cours reprennent là
 *   où elles étaient, après avoir vérifié que ni le film ni la piste source n'ont changé.
 * - **Fin de tâche** : fichier écrit dans `data/subtitles`, puis présenté à Jellyfin (present.ts),
 *   avec ses propres nouveaux essais.
 */

export const MAX_CONCURRENT = 3;
const CONTEXT_LINES = 20;
/** Attentes entre deux essais d'un appel passager, en ms ; au-delà, la tâche se met en pause. */
let TRANSIENT_DELAYS = [2_000, 5_000, 15_000, 30_000];
/** Attentes entre deux envois à Jellyfin ; au-delà, la copie de `data/` est servie à la place. */
const PRESENT_DELAYS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Jellyfin rafraîchit l'élément après l'envoi ; on le lui redemande après 5 min, on abandonne après 45. */
const PRESENT_REFRESH_AFTER = 5 * 60_000;
const PRESENT_GIVE_UP_AFTER = 45 * 60_000;
const BATCH_LOG_EVERY = 60_000;
/**
 * Un saut ne déclenche son lot qu'une fois la position stable une seconde : le lecteur sonde à chaque
 * saut (`noteSeek`, generation.ts), et des appuis répétés sur +10 s ou un défilement de la barre en
 * enverraient un par geste. Chaque nouveau saut relance l'attente ; seule la position finale compte.
 */
let SEEK_SETTLE_MS = 1_000;
/**
 * Un écart plus grand que celui-ci est un geste du spectateur — +10 s compris —, pas le bruit du
 * sondage. Mesuré contre les deux hypothèses (lecture en cours, pause) : en pause la position ne bouge
 * pas, et l'écart à la position « attendue » grandirait de tout l'intervalle de sondage (10 s).
 */
const SEEK_NOISE_S = 5;
/** Au-delà, la rafale est un saut au sens du journal : le seuil qu'avait la ligne `seek` avant le lot de saut. */
const SEEK_LOG_S = 30;

interface JobCues {
  starts: number[];
  ends: number[];
  sources: string[];
  translations: (string | null)[];
  done: Uint8Array;
}

interface Stats {
  batches: number;
  lines: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
  since: number;
}

const emptyStats = (): Stats => ({ batches: 0, lines: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0, since: Date.now() });

interface EngineState {
  running: number;
  inflight: Map<string, Set<number>>;
  viewers: Map<string, Map<string, Viewer>>;
  turns: Map<string, number>;
  cues: Map<string, JobCues>;
  /** Tâches qu'un travail hors lot (préparation, vérification) tient à l'écart de l'ordonnanceur. */
  busy: Set<string>;
  transient: Map<string, { attempt: number; until: number }>;
  stats: Map<string, Stats>;
  lastPlanViewer: Map<string, string>;
  /** Tâches dont le glossaire est en cours : seul le premier lot (et un lot de saut) peut partir sans lui. */
  awaitingGlossary: Set<string>;
  /** Tâches dont un lot de saut est en vol — au plus un par tâche. */
  seekLanes: Set<string>;
  /** Le saut qui attend son lot (un autre en vol, ou la concurrence pleine) : le dernier l'emporte. */
  seekPending: Map<string, SeekIntent>;
  /** La rafale de sauts en cours de chaque spectateur (`tâche\0spectateur`), jusqu'à une seconde de calme. */
  seekBursts: Map<string, SeekBurst>;
  /** La zone d'un lot de saut décidé, jusqu'à sa première ligne écrite (`seekFirst`). */
  seekWatch: Map<string, { at: number; from: number; to: number }>;
  rr: number;
  started: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  presentTimer: ReturnType<typeof setInterval> | null;
  /** Le travail en cours, pour que les tests sachent quand tout s'est tu. */
  pending: Set<Promise<unknown>>;
}

// Sur `globalThis` : le rechargement à chaud de `next dev` réévalue le module, et deux moteurs
// auraient doublé les requêtes (et la facture).
const G = globalThis as unknown as { __cineSubtitleGen?: EngineState };
function freshState(): EngineState {
  return {
    running: 0,
    inflight: new Map(),
    viewers: new Map(),
    turns: new Map(),
    cues: new Map(),
    busy: new Set(),
    transient: new Map(),
    stats: new Map(),
    lastPlanViewer: new Map(),
    awaitingGlossary: new Set(),
    seekLanes: new Set(),
    seekPending: new Map(),
    seekBursts: new Map(),
    seekWatch: new Map(),
    rr: 0,
    started: false,
    timers: new Set(),
    presentTimer: null,
    pending: new Set(),
  };
}
const S = (): EngineState => (G.__cineSubtitleGen ??= freshState());

function track<T>(p: Promise<T>): Promise<T> {
  const s = S();
  s.pending.add(p);
  void p.finally(() => s.pending.delete(p)).catch(() => undefined);
  return p;
}

function later(ms: number, fn: () => void): void {
  const s = S();
  const t = setTimeout(() => {
    s.timers.delete(t);
    fn();
  }, ms);
  // Un minuteur du moteur ne retient jamais le processus (tests, arrêt du conteneur).
  (t as { unref?: () => void }).unref?.();
  s.timers.add(t);
}

// ─── Cache des lignes ─────────────────────────────────────────────────────────

function loadCues(jobId: string): JobCues {
  const s = S();
  const known = s.cues.get(jobId);
  if (known) return known;
  const rows = cuesDb.all(jobId);
  const c: JobCues = {
    starts: rows.map((r) => r.start_s),
    ends: rows.map((r) => r.end_s),
    sources: rows.map((r) => r.source),
    // Une ligne provisoire (un lot interrompu par un redémarrage avant sa validation) n'est pas faite :
    // elle sera retraduite, et la nouvelle traduction la remplacera.
    translations: rows.map((r) => (r.provisional ? null : r.text)),
    done: Uint8Array.from(rows.map((r) => (r.text !== null && !r.provisional ? 1 : 0))),
  };
  s.cues.set(jobId, c);
  return c;
}

// ─── Spectateurs ──────────────────────────────────────────────────────────────

/**
 * Un sondage du lecteur : la position la plus récente fait foi. Un saut ne fait jamais annuler la
 * requête en cours ; une fois la position stable, il peut faire partir un lot de saut (`settleSeek`).
 */
export function noteViewer(jobId: string, key: string, position: number | undefined, now = Date.now()): void {
  if (typeof position !== "number" || !Number.isFinite(position) || position < 0) return;
  const s = S();
  let viewers = s.viewers.get(jobId);
  if (!viewers) s.viewers.set(jobId, (viewers = new Map()));
  const before = viewers.get(key);
  if (before) {
    const expected = before.position + (now - before.seenAt) / 1000;
    const jump = Math.min(Math.abs(position - expected), Math.abs(position - before.position));
    if (jump > SEEK_NOISE_S) noteSeek(jobId, key, before.position, position, now);
  }
  viewers.set(key, { key, position, seenAt: now });
  jobsDb.update(jobId, { last_position: position });
  kick();
}

interface SeekIntent {
  viewer: string;
  /** Quand le saut a été reçu : le départ de `seekToFirstMs`. */
  at: number;
  from: number;
  to: number;
}

interface SeekBurst {
  /** La position d'avant le premier geste de la rafale. */
  from: number;
  to: number;
  /** Le dernier geste reçu : l'attente d'une seconde court de là, et `seekToFirstMs` aussi. */
  at: number;
  jumps: number;
  seq: number;
}

function noteSeek(jobId: string, viewer: string, from: number, to: number, at: number): void {
  const s = S();
  const k = `${jobId}\u0000${viewer}`;
  const burst = s.seekBursts.get(k) ?? { from, to, at, jumps: 0, seq: 0 };
  burst.to = to;
  burst.at = at;
  burst.jumps++;
  const seq = ++burst.seq;
  s.seekBursts.set(k, burst);
  later(SEEK_SETTLE_MS, () => settleSeek(jobId, viewer, seq));
}

/**
 * Le saut, une fois la position stable : la ligne `seek` du journal, et le lot de saut s'il le faut.
 * Mesuré en prod (8.43.1, 12/10/2026) : un saut dans une zone non traduite était couvert en 6,1 s —
 * le lot de 40 en cours devait finir avant que la zone du saut passe en tête, une requête à la fois
 * par tâche. Le lot de saut part à côté de lui, sans l'annuler (ses lignes serviront).
 */
function settleSeek(jobId: string, viewer: string, seq: number): void {
  const s = S();
  const k = `${jobId}\u0000${viewer}`;
  const burst = s.seekBursts.get(k);
  // Un geste plus récent a relancé l'attente : c'est son minuteur qui décidera.
  if (!burst || burst.seq !== seq) return;
  s.seekBursts.delete(k);
  // Le dernier saut l'emporte : celui qui attendait sa place est oublié, celui-ci décide.
  s.seekPending.delete(jobId);
  const outcome = seekLane(jobId, { viewer, at: burst.at, from: burst.from, to: burst.to });
  const fastLane = outcome === "launched" || outcome === "queued";
  // Pas de lot pour ce saut : la zone d'un saut précédent ne doit plus être mesurée en son nom.
  if (!fastLane) s.seekWatch.delete(jobId);
  // Deux appuis sur +10 s vers une zone faite ne sont pas un saut pour le journal ; un lot parti, si.
  if (!fastLane && Math.abs(burst.to - burst.from) <= SEEK_LOG_S) return;
  logGen("seek", {
    job: jobId,
    from: Math.round(burst.from),
    to: Math.round(burst.to),
    jumps: burst.jumps,
    fastLane,
    ...(outcome === "queued" ? { queued: true } : fastLane ? {} : { why: outcome }),
  });
}

/**
 * Lancer le lot de saut de cette tâche, le mettre en attente, ou dire pourquoi il n'a pas lieu :
 * `done` (la zone est faite), `inflight` (un lot la porte déjà), `end`, `busy`, `retry-wait`,
 * `not-running`. La position relue est la plus récente du spectateur, pas celle du saut.
 */
function seekLane(jobId: string, intent: SeekIntent, now = Date.now()): "launched" | "queued" | string {
  const s = S();
  const job = jobsDb.get(jobId);
  if (!job || job.status !== "running" || job.total === 0) return "not-running";
  if (s.busy.has(jobId)) return "busy";
  const wait = s.transient.get(jobId);
  if (wait && wait.until > now) return "retry-wait";
  const cues = loadCues(jobId);
  const inflight = s.inflight.get(jobId) ?? new Set<number>();
  const position = s.viewers.get(jobId)?.get(intent.viewer)?.position ?? intent.to;
  const plan = seekBatch({ starts: cues.starts, ends: cues.ends, done: cues.done, inflight }, position);
  if (!plan) {
    const anchor = anchorIndex(cues.starts, cues.ends, position);
    return anchor >= cues.starts.length ? "end" : cues.done[anchor] ? "done" : "inflight";
  }
  s.seekWatch.set(jobId, { at: intent.at, from: plan.from, to: plan.from + plan.count });
  // Un seul lot de saut par tâche, et un seul au-delà de la concurrence : sinon il attend, en tête de
  // file (`pump` le lance avant tout lot ordinaire) — et un saut plus récent le remplace.
  if (s.seekLanes.has(jobId) || s.running >= MAX_CONCURRENT + 1) {
    s.seekPending.set(jobId, intent);
    return "queued";
  }
  s.seekPending.delete(jobId);
  void track(runBatch(job, plan, true));
  return "launched";
}

export function viewersOf(jobId: string, now = Date.now()): Viewer[] {
  return activeViewers([...(S().viewers.get(jobId)?.values() ?? [])], now);
}

// ─── Pauses ───────────────────────────────────────────────────────────────────

function pause(job: Pick<JobRow, "id" | "status">, reason: string): void {
  if (job.status !== "running" && job.status !== "preparing") return;
  jobsDb.update(job.id, { status: "paused", reason });
  logGen("pause", { job: job.id, reason });
}

/** La clé, le crédit ou le budget valent pour toutes les tâches à la fois. */
function pauseAll(reason: string): void {
  for (const job of jobsDb.withStatus(["running", "preparing"])) pause(job, reason);
}

function overBudget(now = Date.now()): boolean {
  return spendDb.month(now).cost >= budgetOf(config.subtitleGen.budgetUsd);
}

/**
 * Peut-on dépenser maintenant ? Sinon, met tout en pause avec la raison, et répond non.
 * Vérifié avant chaque appel, pas seulement à la création : la clé peut avoir été retirée entre-temps.
 */
function canSpend(): GenSettings | null {
  const settings = genSettings();
  if (!genAvailable(settings)) {
    pauseAll("config");
    return null;
  }
  if (overBudget()) {
    pauseAll("budget");
    return null;
  }
  return settings;
}

// ─── Facturation ──────────────────────────────────────────────────────────────

function bill(jobId: string, settings: GenSettings, usage: Usage | null): void {
  if (!usage || !settings.price) return;
  const cost = costOf(usage, settings.price);
  jobsDb.addUsage(jobId, usage, cost);
  spendDb.add(cost, usage);
  const st = statsOf(jobId);
  st.inputTokens += usage.inputTokens;
  st.cacheWriteTokens += usage.cacheWriteTokens;
  st.cacheReadTokens += usage.cacheReadTokens;
  st.outputTokens += usage.outputTokens;
  st.cost += cost;
}

function statsOf(jobId: string): Stats {
  const s = S();
  let st = s.stats.get(jobId);
  if (!st) s.stats.set(jobId, (st = emptyStats()));
  return st;
}

function flushStats(jobId: string, force = false): void {
  const st = S().stats.get(jobId);
  if (!st || st.batches === 0) return;
  if (!force && Date.now() - st.since < BATCH_LOG_EVERY) return;
  logGen("batch", {
    job: jobId,
    batches: st.batches,
    count: st.lines,
    inputTokens: st.inputTokens,
    cacheWriteTokens: st.cacheWriteTokens,
    cacheReadTokens: st.cacheReadTokens,
    outputTokens: st.outputTokens,
    cacheReadRate: cacheReadRate(st),
    cost: Number(st.cost.toFixed(5)),
  });
  S().stats.set(jobId, emptyStats());
}

// ─── Ordonnancement ───────────────────────────────────────────────────────────

/** Relancer l'ordonnanceur. Sans effet tant que le moteur n'est pas démarré. */
export function kick(): void {
  if (!S().started) return;
  pump();
}

function pump(): void {
  const s = S();
  // Les lots de saut en attente d'abord : ils passent devant la file (et peuvent la dépasser d'un).
  for (const [jobId, intent] of [...s.seekPending]) {
    if (s.seekLanes.has(jobId) || s.running >= MAX_CONCURRENT + 1) continue;
    s.seekPending.delete(jobId);
    seekLane(jobId, intent);
  }
  while (s.running < MAX_CONCURRENT) {
    const choice = choose();
    if (!choice) return;
    void track(runBatch(choice.job, choice.plan));
  }
}

function choose(now = Date.now()): { job: JobRow; plan: Plan } | null {
  const s = S();
  const options: { job: JobRow; plan: Plan; cls: number }[] = [];
  for (const job of jobsDb.withStatus(["running"])) {
    if (s.busy.has(job.id) || job.total === 0) continue;
    // Une requête à la fois par tâche — voir l'en-tête : le cache du préfixe ne se partage qu'en série.
    if (countBatches(job.id) > 0) continue;
    // Le glossaire en préparation : seul le premier lot n'attend pas.
    if (s.awaitingGlossary.has(job.id) && job.done > 0) continue;
    const wait = s.transient.get(job.id);
    if (wait && wait.until > now) continue;
    const cues = loadCues(job.id);
    const inflight = s.inflight.get(job.id) ?? new Set<number>();
    const viewers = [...(s.viewers.get(job.id)?.values() ?? [])];
    const plan = nextBatch({
      starts: cues.starts,
      ends: cues.ends,
      done: cues.done,
      inflight,
      viewers,
      now,
      turn: s.turns.get(job.id) ?? 0,
      resumeFrom: job.last_position,
      first: job.done === 0 && inflight.size === 0,
    });
    if (!plan || plan.count === 0) continue;
    const cls = plan.why === "viewer" ? 0 : viewersOf(job.id, now).length > 0 ? 1 : 2;
    options.push({ job, plan, cls });
  }
  if (options.length === 0) return null;
  const best = Math.min(...options.map((o) => o.cls));
  const tier = options.filter((o) => o.cls === best);
  const pick = tier[s.rr++ % tier.length];
  s.turns.set(pick.job.id, (s.turns.get(pick.job.id) ?? 0) + 1);
  return pick;
}

const batchCounts = new Map<string, number>();
function countBatches(jobId: string): number {
  return batchCounts.get(jobId) ?? 0;
}

// ─── Un lot ───────────────────────────────────────────────────────────────────

class Transient extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}
class Stop extends Error {}

/**
 * Un lot. `seekLane` : le lot de saut, compté à part de `batchCounts` — le lot ordinaire de la tâche
 * continue (et le suivant repart de la position du spectateur, après les lignes du lot de saut,
 * marquées en vol comme les autres).
 */
async function runBatch(job: JobRow, plan: Plan, seekLane = false): Promise<void> {
  const s = S();
  const ids = Array.from({ length: plan.count }, (_, i) => plan.from + i);
  let inflight = s.inflight.get(job.id);
  if (!inflight) s.inflight.set(job.id, (inflight = new Set()));
  for (const i of ids) inflight.add(i);
  if (seekLane) s.seekLanes.add(job.id);
  else batchCounts.set(job.id, countBatches(job.id) + 1);
  s.running++;
  if (plan.viewer && s.lastPlanViewer.get(job.id) !== `${plan.viewer}:${plan.from}`) s.lastPlanViewer.set(job.id, `${plan.viewer}:${plan.from}`);
  try {
    await translateIds(job, ids, 0, seekLane);
    s.transient.delete(job.id);
  } catch (error) {
    if (error instanceof Transient) {
      const t = s.transient.get(job.id) ?? { attempt: 0, until: 0 };
      if (t.attempt >= TRANSIENT_DELAYS.length) {
        s.transient.delete(job.id);
        pause(jobsDb.get(job.id) ?? job, "unavailable");
      } else {
        const delay = TRANSIENT_DELAYS[t.attempt];
        s.transient.set(job.id, { attempt: t.attempt + 1, until: Date.now() + delay });
        logGen("retry", { job: job.id, cause: error.kind, attempt: t.attempt + 1, delayMs: delay });
        later(delay + 10, kick);
      }
    } else if (!(error instanceof Stop)) {
      logError("subtitle-gen: lot", error);
      pause(jobsDb.get(job.id) ?? job, "error");
    }
  } finally {
    for (const i of ids) inflight.delete(i);
    if (seekLane) s.seekLanes.delete(job.id);
    else batchCounts.set(job.id, Math.max(0, countBatches(job.id) - 1));
    s.running--;
    flushStats(job.id);
    const fresh = jobsDb.get(job.id);
    if (fresh && fresh.status === "running" && fresh.done >= fresh.total && fresh.total > 0) await finish(fresh);
    kick();
  }
}

/**
 * Traduire ces lignes : essai, nouvel essai, puis moitiés, puis la ligne seule garde son texte
 * source. Les erreurs passagères et de configuration remontent ; les refus et réponses invalides
 * se règlent ici.
 */
async function translateIds(job: JobRow, ids: number[], tries: number, seekLane = false, previousDrift?: Map<number, string>): Promise<void> {
  const cues = loadCues(job.id);
  const open = ids.filter((i) => !cues.done[i]);
  if (open.length === 0) return;
  const settings = canSpend();
  if (!settings) throw new Stop();
  const current = jobsDb.get(job.id);
  if (!current || current.status !== "running") throw new Stop();

  const provider = providerFor(settings);
  if (current.provider !== settings.provider || current.model !== settings.model) jobsDb.update(job.id, { provider: settings.provider, model: settings.model });
  const requested = open.map((id) => ({ id, source: cues.sources[id] }));
  // Le contexte proche : les traductions déjà faites juste avant le lot (le texte source, lui, est
  // déjà entier dans le préfixe).
  const previous: { i: number; text: string }[] = [];
  for (let i = Math.max(0, open[0] - CONTEXT_LINES); i < open[0]; i++) {
    const text = cues.translations[i];
    if (text !== null) previous.push({ i, text });
  }

  // Les lignes reçues en flux et écrites, provisoires, pendant cet essai : effacées si le lot n'est
  // pas validé, quoi qu'il arrive (refus, réponse coupée, coupure réseau).
  const streamed = new Set<number>();
  const startedAt = Date.now();
  const sourceOf = (id: number) => cues.sources[id];
  const asked = new Set(open);
  const splitter = new LineSplitter((line) => {
    const parsed = parseReplyLine(line);
    // Validable seule : un identifiant demandé, un texte non vide, pas plus de lignes que permis.
    // Le reste (comptes, décalage) attend la fin du lot.
    if (!parsed || !asked.has(parsed.i) || !parsed.text) return;
    const text = matchSourceCase(cues.sources[parsed.i], fitLines(parsed.text, maxLinesFor(cues.sources[parsed.i])), job.target);
    if (cuesDb.writeProvisional(job.id, [{ idx: parsed.i, text }]) > 0) {
      streamed.add(parsed.i);
      noteFirst(job.id, 1, startedAt, true);
      noteSeekFirst(job.id, [parsed.i], startedAt, true, seekLane);
    }
  });

  let verdict: ReturnType<typeof validateBatch> | null = null;
  let problem = "";
  try {
    try {
      const reply = await provider.complete({
        system: batchSystem(job.target, current.source_lang),
        stable: stablePrefix(current.glossary ? parseGlossary(JSON.parse(current.glossary)) : null, cues.sources),
        cache: true,
        user: batchUser(previous, open, cues.sources),
        schemaName: "subtitle_batch",
        // ~24 jetons par réplique en lignes (mesuré), 60 au plus pour une longue ; la marge pour le reste.
        maxOutputTokens: Math.max(1024, open.length * 150),
        onText: (delta) => splitter.push(delta),
      });
      bill(job.id, settings, reply.usage);
      verdict = validateBatch(requested, parseReply(reply.text), sourceOf);
      if (!verdict.ok) problem = verdict.problem;
    } catch (error) {
      if (!(error instanceof ProviderError)) throw new Transient("network");
      bill(job.id, settings, error.usage);
      switch (error.kind) {
        case "rate":
        case "server":
        case "network":
          throw new Transient(error.kind);
        case "auth":
        case "config":
          pauseAll("config");
          throw new Stop();
        case "credit":
          pauseAll("budget");
          throw new Stop();
        case "refusal":
          problem = "refusal";
          logGen("refusal", { job: job.id, count: open.length, detail: error.message });
          break;
        default:
          problem = error.kind;
      }
    }
  } finally {
    if (!verdict?.ok && streamed.size > 0) cuesDb.clearProvisional(job.id, [...streamed]);
  }

  if (verdict?.ok) {
    record(job, open.map((id) => ({ idx: id, text: matchSourceCase(cues.sources[id], verdict.texts.get(id)!, job.target), kept: false })), startedAt, seekLane);
    return;
  }
  // Deuxième alerte de décalage sur les mêmes lignes, et une réponse de même forme que la première :
  // c'est la source qui trompe le détecteur, pas le modèle qui glisse — voir `sameShape`.
  const driftTexts = verdict && !verdict.ok && verdict.problem === "drift" ? verdict.texts : undefined;
  if (driftTexts && previousDrift && sameShape(previousDrift, driftTexts)) {
    logGen("retry", { job: job.id, cause: "drift-accepted", attempt: tries + 1, count: open.length });
    record(job, open.map((id) => ({ idx: id, text: matchSourceCase(cues.sources[id], driftTexts.get(id)!, job.target), kept: false })), startedAt, seekLane);
    return;
  }
  // Un lot refusé se dit — le décalage surtout, qui passait inaperçu avant le détecteur.
  if (problem !== "refusal") logGen("retry", { job: job.id, cause: problem, attempt: tries + 1, count: open.length, streamed: streamed.size });
  if (tries < 1 && problem !== "refusal") return translateIds(job, open, tries + 1, seekLane, driftTexts);
  if (open.length > 1) {
    const half = Math.ceil(open.length / 2);
    await translateIds(job, open.slice(0, half), 0, seekLane);
    await translateIds(job, open.slice(half), 0, seekLane);
    return;
  }
  // Une ligne qui résiste à tout garde son texte d'origine : mieux vaut une réplique dans la langue
  // du film qu'un trou — et le journal le dit.
  logGen("kept", { job: job.id, index: open[0], why: problem });
  record(job, [{ idx: open[0], text: cues.sources[open[0]], kept: true }], Date.now(), seekLane);
}

function record(job: JobRow, entries: { idx: number; text: string; kept: boolean }[], startedAt = Date.now(), seekLane = false): void {
  const cues = loadCues(job.id);
  const { written } = cuesDb.write(job.id, entries);
  for (const e of entries) {
    cues.done[e.idx] = 1;
    cues.translations[e.idx] ??= e.text;
  }
  const st = statsOf(job.id);
  st.batches++;
  st.lines += written;
  noteFirst(job.id, written, startedAt, false);
  if (written > 0) noteSeekFirst(job.id, entries.map((e) => e.idx), startedAt, false, seekLane);
}

/**
 * La première ligne écrite dans la zone d'un lot de saut décidé : `seekToFirstMs` va du saut reçu à
 * l'écriture — le pendant de `first` pour un saut, à comparer aux 6,1 s d'avant le lot de saut.
 * `fastLane` dit qui l'a écrite (un lot ordinaire peut gagner, si le lot de saut attendait sa place).
 */
function noteSeekFirst(jobId: string, idxs: number[], startedAt: number, streamed: boolean, seekLane: boolean): void {
  const s = S();
  const watch = s.seekWatch.get(jobId);
  if (!watch || !idxs.some((i) => i >= watch.from && i < watch.to)) return;
  s.seekWatch.delete(jobId);
  const now = Date.now();
  logGen("seekFirst", { job: jobId, seekToFirstMs: now - watch.at, requestToFirstMs: now - startedAt, streamed, fastLane: seekLane });
}

/**
 * La première ligne écrite d'une tâche, une fois : `ms` (et `clickToFirstMs`, le même, nommé) va du
 * clic — la création de la tâche — à l'écriture ; `requestToFirstMs` de l'envoi du lot à l'écriture.
 * Le 12/10/2026, la première ligne arrivait 18,5 s après le clic alors qu'un premier lot ne prend que
 * 1,5-2,7 s : l'écart entre les deux champs dit où passe l'attente.
 */
function noteFirst(jobId: string, written: number, startedAt: number, streamed: boolean): void {
  if (written <= 0) return;
  const fresh = jobsDb.get(jobId);
  if (!fresh || fresh.first_ms !== null) return;
  const now = Date.now();
  const ms = now - fresh.created_at;
  jobsDb.update(jobId, { first_ms: ms });
  logGen("first", { job: jobId, ms, clickToFirstMs: ms, requestToFirstMs: now - startedAt, streamed, count: written });
}

// ─── Préparation ──────────────────────────────────────────────────────────────

/**
 * Choisir la source, en garder les lignes, demander le glossaire. Le premier lot part dès que les
 * lignes sont là, en parallèle du glossaire : afficher vite compte plus que la cohérence des huit
 * premières répliques.
 */
export function prepare(jobId: string): Promise<void> {
  const s = S();
  if (s.busy.has(jobId)) return Promise.resolve();
  s.busy.add(jobId);
  return track(
    (async () => {
      try {
        await prepareNow(jobId);
      } catch (error) {
        logError("subtitle-gen: préparation", error);
        const job = jobsDb.get(jobId);
        if (job) pause(job, "unavailable");
      } finally {
        s.busy.delete(jobId);
        kick();
      }
    })()
  );
}

async function prepareNow(jobId: string): Promise<void> {
  const job = jobsDb.get(jobId);
  if (!job || job.status !== "preparing") return;
  const candidates = JSON.parse(job.candidates) as SourceCandidate[];
  let chosen: { c: SourceCandidate; cues: { start: number; end: number; text: string }[] } | null = null;
  for (const c of candidates) {
    let cues: { start: number; end: number; text: string }[];
    try {
      cues = await fetchSourceCues(job.item_id, job.media_source_id, c.index);
    } catch (error) {
      logGen("source", { job: jobId, index: c.index, verdict: "illisible", detail: error instanceof Error ? error.message : "?" });
      continue;
    }
    const full = isFullTrack(cues.length, job.runtime_seconds, cues.at(-1)?.end ?? 0);
    logGen("source", { job: jobId, index: c.index, external: c.external, language: c.language, forcedFlag: c.forcedFlag, cues: cues.length, verdict: full ? "complète" : "trop courte" });
    if (full) {
      chosen = { c, cues };
      break;
    }
  }
  if (!chosen) {
    jobsDb.update(jobId, { status: "failed", reason: "no-source" });
    logGen("pause", { job: jobId, reason: "no-source" });
    return;
  }
  cuesDb.replaceAll(jobId, chosen.cues);
  S().cues.delete(jobId);
  jobsDb.update(jobId, {
    status: "running",
    reason: null,
    total: chosen.cues.length,
    done: 0,
    source_index: chosen.c.index,
    source_external: chosen.c.external ? 1 : 0,
    source_lang: chosen.c.language,
    source_hi: chosen.c.hearingImpaired ? 1 : 0,
    source_hash: sourceHash(chosen.cues),
  });
  const s = S();
  s.awaitingGlossary.add(jobId);
  // La tâche quitte `busy` dès que ses lignes sont en base : `choose` saute les tâches `busy`, et le
  // « premier lot en parallèle du glossaire » attendait en réalité le glossaire — 18,5 s avant la
  // première ligne en prod le 12/10/2026, pour un lot qui en prend 2. Les lots suivants l'attendent
  // toujours, par `awaitingGlossary`.
  s.busy.delete(jobId);
  kick();
  try {
    await requestGlossary(jobId, chosen.c, chosen.cues.map((c) => c.text));
  } finally {
    s.awaitingGlossary.delete(jobId);
  }
}

async function requestGlossary(jobId: string, candidate: SourceCandidate, lines: string[]): Promise<void> {
  const settings = canSpend();
  const job = jobsDb.get(jobId);
  if (!settings || !job) return;
  let provider: TranslationProvider;
  try {
    provider = providerFor(settings);
    const reply = await provider.complete({
      system: glossarySystem(job.target),
      // Le même bloc source que les lots, mais derrière d'autres consignes : un préfixe à part, qui
      // ne sert qu'une fois — pas de point de cache (l'écriture coûterait 25 % de plus pour rien).
      stable: [sourceBlock(lines)],
      cache: false,
      user: GLOSSARY_USER,
      schema: GLOSSARY_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "subtitle_glossary",
      maxOutputTokens: 4000,
    });
    bill(jobId, settings, reply.usage);
    const glossary: Glossary | null = parseGlossary(reply.json);
    if (!glossary) return;
    const detected = twoLetter(glossary.source_language);
    jobsDb.update(jobId, { glossary: JSON.stringify(glossary), ...(detected && !candidate.language ? { source_lang: detected } : {}) });
    // La langue vérifiée : une piste sans étiquette qui est déjà dans la langue voulue ne se
    // « traduit » pas — la tâche s'arrête et le dit.
    if (detected && detected === job.target) {
      jobsDb.update(jobId, { status: "failed", reason: "exists" });
      logGen("pause", { job: jobId, reason: "exists", detected });
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      bill(jobId, settings, error.usage);
      if (error.kind === "auth" || error.kind === "config") pauseAll("config");
      else if (error.kind === "credit") pauseAll("budget");
      // Le reste (refus, réseau) : on traduit sans glossaire plutôt que d'attendre.
      logGen("retry", { job: jobId, cause: `glossary-${error.kind}`, attempt: 1, delayMs: 0 });
      return;
    }
    logError("subtitle-gen: glossaire", error);
  }
}

// ─── Fin ──────────────────────────────────────────────────────────────────────

async function finish(job: JobRow): Promise<void> {
  // Deux lots qui finissent ensemble verraient tous deux la tâche complète : un seul la termine.
  const current = jobsDb.get(job.id);
  if (!current || current.status !== "running") return;
  const rows = cuesDb.all(job.id);
  if (rows.some((r) => r.text === null || r.provisional)) return;
  const final = rows.map((r) => ({ start: r.start_s, end: r.end_s, text: r.text as string }));
  const { hash } = writeFinal(job.item_id, job.id, job.target, final);
  const now = Date.now();
  jobsDb.update(job.id, { status: "done", reason: null, finished_at: now, out_hash: hash, present_state: "pending", present_next_at: now, present_attempts: 0 });
  flushStats(job.id, true);
  const fresh = jobsDb.get(job.id)!;
  logGen("done", {
    job: job.id,
    item: job.item_id,
    title: job.title,
    target: job.target,
    total: fresh.total,
    kept: fresh.kept_source,
    requests: fresh.requests,
    inputTokens: fresh.input_tokens,
    cacheWriteTokens: fresh.cache_write_tokens,
    cacheReadTokens: fresh.cache_read_tokens,
    outputTokens: fresh.output_tokens,
    // Le coût de sortie par réplique : ≈ 24 jetons en lignes contre ≈ 33 en JSON (banc du 12/10/2026).
    outputTokensPerLine: fresh.total > 0 ? Number((fresh.output_tokens / fresh.total).toFixed(1)) : null,
    cacheReadRate: cacheReadRate({ inputTokens: fresh.input_tokens, cacheWriteTokens: fresh.cache_write_tokens, cacheReadTokens: fresh.cache_read_tokens }),
    cost: Number(fresh.cost_usd.toFixed(5)),
    durationMs: now - fresh.created_at,
  });
  S().cues.delete(job.id);
  S().viewers.delete(job.id);
  S().seekPending.delete(job.id);
  S().seekWatch.delete(job.id);
  void track(presentTick());
}

// ─── Présentation à Jellyfin ──────────────────────────────────────────────────

/**
 * Faire avancer chaque tâche terminée vers « présentée ». Appelé toutes les 30 s et à chaque fin
 * de tâche. Un envoi qui échoue réessaie (1 min, 5 min, 15 min, 1 h), puis abandonne : la route
 * `direct` sert alors la copie de `data/`.
 */
export async function presentTick(now = Date.now()): Promise<void> {
  for (const job of jobsDb.presenting()) {
    try {
      if (job.present_state === "pending" && (job.present_next_at ?? 0) <= now) await presentUpload(job, now);
      else if (job.present_state === "uploaded") await presentCheck(job, now);
    } catch (error) {
      logError("subtitle-gen: présentation", error);
    }
  }
}

function presentFail(job: JobRow, reason: string): void {
  jobsDb.update(job.id, { present_state: "failed", present_reason: reason });
  logGen("present", { job: job.id, state: "failed", reason });
}

async function presentUpload(job: JobRow, now: number): Promise<void> {
  let source;
  try {
    source = await fetchItemSource(job.item_id, job.media_source_id);
  } catch {
    return retryUpload(job, now, "jellyfin");
  }
  if (!source) return presentFail(job, "item-missing");
  if (!sameFile(job, source)) {
    markStale(job, "file-changed");
    return;
  }
  const videoPath = source.videoPath ?? job.video_path;
  if (!videoPath) return presentFail(job, "no-path");
  const existing = externalSubtitlePaths(source.streams);
  if (nameTaken(videoPath, job.target, job.source_hi === 1, existing)) return presentFail(job, "name-taken");
  const srt = readFinal(job.item_id, job.id, job.target, "srt");
  if (!srt) return presentFail(job, "file-missing");
  // La liste d'avant l'envoi, gardée d'abord : c'est elle qui dit plus tard quel fichier est le nôtre.
  jobsDb.update(job.id, { present_pre_paths: JSON.stringify(existing), video_path: videoPath });
  try {
    await uploadSubtitle(job.item_id, job.target, job.source_hi === 1, srt);
  } catch (error) {
    return retryUpload(job, now, error instanceof Error ? error.message : "envoi");
  }
  jobsDb.update(job.id, { present_state: "uploaded", present_uploaded_at: now, present_reason: null });
  logGen("present", { job: job.id, state: "uploaded" });
}

function retryUpload(job: JobRow, now: number, reason: string): void {
  const attempts = job.present_attempts + 1;
  if (attempts > PRESENT_DELAYS.length) return presentFail(job, `upload: ${reason}`);
  jobsDb.update(job.id, { present_attempts: attempts, present_next_at: now + PRESENT_DELAYS[attempts - 1], present_reason: reason });
  logGen("present", { job: job.id, state: "retry", attempt: attempts, reason });
}

async function presentCheck(job: JobRow, now: number): Promise<void> {
  const source = await fetchItemSource(job.item_id, job.media_source_id).catch(() => null);
  if (source) {
    const facts = { videoPath: job.video_path, target: job.target, prePaths: JSON.parse(job.present_pre_paths ?? "[]") as string[], knownPath: null };
    const ours = source.streams.find((s) => isOurStream(s, facts));
    if (ours) {
      jobsDb.update(job.id, { present_state: "presented", present_path: ours.Path ?? null, present_index: ours.Index, present_reason: null });
      logGen("present", { job: job.id, state: "presented", index: ours.Index });
      return;
    }
  }
  const since = now - (job.present_uploaded_at ?? now);
  if (since > PRESENT_GIVE_UP_AFTER) return presentFail(job, "not-listed");
  if (since > PRESENT_REFRESH_AFTER && job.present_reason !== "refresh-asked") {
    await refreshItem(job.item_id);
    jobsDb.update(job.id, { present_reason: "refresh-asked" });
  }
}


/**
 * Le fichier vidéo ou la piste source ont changé : la tâche est obsolète. Le sous-titre que nous
 * avions fait poser chez Jellyfin n'est retiré que s'il est le nôtre **avec certitude** — le chemin
 * mémorisé et le même texte relu. Dans le doute, rien n'est supprimé, et le journal le dit.
 */
export function markStale(job: JobRow, why: string): void {
  if (job.status === "stale") return;
  jobsDb.update(job.id, { status: "stale", reason: why });
  logGen("pause", { job: job.id, reason: "stale", why });
  S().cues.delete(job.id);
  if (job.present_state === "presented" && job.present_path && job.present_index !== null) void track(cleanupPresented(job));
}

export async function cleanupPresented(job: JobRow): Promise<"deleted" | "skipped"> {
  try {
    const source = await fetchItemSource(job.item_id, job.media_source_id).catch(() => null);
    const streams = source?.streams ?? [];
    const stream = streams.find((s) => s.Type === "Subtitle" && s.IsExternal && s.Path === job.present_path);
    if (!source || !stream || !job.out_hash) {
      logGen("cleanup", { job: job.id, result: "skipped", why: "introuvable" });
      return "skipped";
    }
    const hash = await streamTextHash(job.item_id, source.mediaSourceId, stream.Index).catch(() => null);
    if (hash !== job.out_hash) {
      logGen("cleanup", { job: job.id, result: "skipped", why: "texte différent" });
      return "skipped";
    }
    const ok = await deleteSubtitle(job.item_id, stream.Index);
    logGen("cleanup", { job: job.id, result: ok ? "deleted" : "skipped", why: ok ? "" : "refus" });
    return ok ? "deleted" : "skipped";
  } catch (error) {
    logError("subtitle-gen: retrait", error);
    return "skipped";
  }
}

// ─── Démarrage, reprise ───────────────────────────────────────────────────────

/**
 * Au démarrage du serveur : chaque tâche en cours vérifie que le film et sa piste source sont
 * toujours les mêmes, puis reprend — ses lignes acquises gardées. Une tâche en préparation
 * recommence sa préparation.
 */
export function startEngine(): void {
  const s = S();
  if (s.started) return;
  s.started = true;
  for (const job of jobsDb.withStatus(["preparing"])) void prepare(job.id);
  for (const job of jobsDb.withStatus(["running"])) void verifyThenResume(job.id);
  s.presentTimer = setInterval(() => void track(presentTick()), 30_000);
  (s.presentTimer as { unref?: () => void }).unref?.();
  void track(presentTick());
  kick();
}

function verifyThenResume(jobId: string): Promise<void> {
  const s = S();
  s.busy.add(jobId);
  return track(
    (async () => {
      try {
        const job = jobsDb.get(jobId);
        if (!job) return;
        const source = await fetchItemSource(job.item_id, job.media_source_id).catch(() => undefined);
        if (source === null || (source && !sameFile(job, source))) return markStale(job, "file-changed");
        if (source && job.source_index !== null && job.source_hash) {
          const cues = await fetchSourceCues(job.item_id, job.media_source_id, job.source_index).catch(() => null);
          if (cues && sourceHash(cues) !== job.source_hash) return markStale(job, "source-changed");
        }
        logGen("start", { job: jobId, resumed: true, done: job.done, total: job.total });
      } finally {
        s.busy.delete(jobId);
        kick();
      }
    })()
  );
}

/** Qui demande la reprise : le compte (`created_by` s'écrit sous ce même nom) et s'il administre. */
export interface ResumeBy {
  user: string;
  admin: boolean;
}

/**
 * Reprendre une tâche en pause (un nouveau POST). Rend le statut après coup.
 *
 * Seul le compte qui l'a lancée, ou un administrateur, la reprend (`by`) — pour tout autre, elle
 * n'existe pas (`null`, un 404 qui ne dit rien de plus). Les identifiants de tâche circulent
 * (rejoindre la génération d'un titre rend celui de la tâche d'un autre, le relevé aussi), et n'importe
 * quel compte relançait ainsi une tâche mise en pause par le budget ou par ses erreurs — autant d'appels
 * payants que son auteur n'avait pas redemandés (revue de sécurité du 20/10/2026). Un compte qui a
 * seulement rejoint la tâche ne la relance donc plus : il attend son auteur, ou un administrateur.
 * Sans `by` : un appel interne.
 */
export function resumeJob(jobId: string, by?: ResumeBy): JobRow | null {
  const job = jobsDb.get(jobId);
  if (!job) return null;
  if (by && !by.admin && job.created_by !== by.user) return null;
  if (job.status !== "paused") return job;
  if (job.reason === "budget" && overBudget()) return job;
  if (!genAvailable()) return jobsDb.get(jobId);
  const status = job.total > 0 ? "running" : "preparing";
  jobsDb.update(jobId, { status, reason: null });
  S().transient.delete(jobId);
  logGen("start", { job: jobId, resumed: true, manual: true });
  if (status === "preparing") void prepare(jobId);
  else kick();
  return jobsDb.get(jobId);
}

export function cancelJob(jobId: string): JobRow | null {
  const job = jobsDb.get(jobId);
  if (!job) return null;
  if (job.status === "done" || job.status === "stale" || job.status === "failed") return job;
  jobsDb.update(jobId, { status: "failed", reason: "cancelled" });
  logGen("pause", { job: jobId, reason: "cancelled" });
  return jobsDb.get(jobId);
}

/** Tout ce que le moteur a lancé est-il fini ? Pour les tests. */
export async function whenIdle(): Promise<void> {
  const s = S();
  for (let i = 0; i < 200 && (s.pending.size > 0 || s.running > 0); i++) await Promise.allSettled([...s.pending]);
}

export function resetEngineForTests(): void {
  const s = S();
  for (const t of s.timers) clearTimeout(t);
  if (s.presentTimer) clearInterval(s.presentTimer);
  batchCounts.clear();
  G.__cineSubtitleGen = freshState();
}

/** Les attentes entre essais passagers, raccourcies par les tests. */
export function setTransientDelaysForTests(delays: number[] | null): void {
  TRANSIENT_DELAYS = delays ?? [2_000, 5_000, 15_000, 30_000];
}

/** L'attente de stabilité d'un saut, raccourcie par les tests (`null` : 1 s). */
export function setSeekSettleForTests(ms: number | null): void {
  SEEK_SETTLE_MS = ms ?? 1_000;
}

/** Reste-t-il du travail en vol ou programmé ? Pour les tests. */
export function engineBusy(): boolean {
  const s = S();
  return s.pending.size > 0 || s.running > 0 || s.timers.size > 0;
}

/** Démarrer sans reprise ni minuterie : les tests pilotent eux-mêmes. */
export function startForTests(): void {
  S().started = true;
}
