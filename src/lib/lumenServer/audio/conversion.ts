// La conversion du son de Lumen serveur en service : la file, les priorités, l'avance, l'admission (DECISIONS.md
// §161 à §163). Un seul état par processus, sur `globalThis` (chaque route a sa copie du module).
//
// **La file** (`AudioQueue`) borne les processus ffmpeg simultanés (`LUMEN_AUDIO_MAX_JOBS`, relu à chaque départ ;
// défaut fixé par la mesure de mise à l'échelle, §163) et sert deux priorités :
// - **la demande** : un segment que le lecteur attend (un démarrage, un saut, un segment que l'avance n'a pas fait)
//   — `nice` 10, devant toute avance ; si toutes les places sont prises et qu'une avance tourne, l'avance la plus
//   récente est **tuée** (elle cède sa place, l'avance la refera) ;
// - **l'avance** : 120 s converties devant le dernier segment demandé de chaque lecture, par tâches d'au plus 60 s
//   (un processus pour une quinzaine de segments, mêmes octets que des segments faits un par un), `nice` 15,
//   arrêtée deux minutes après la dernière requête de la lecture — plus personne ne lit, plus rien ne part. Rien
//   derrière la tête de lecture.
// Une demande qui attend plus de 8 s (file pleine, machine saturée) répond « occupé » (503, `Retry-After: 1`), la
// convention de §156 ; la conversion continue et remplit le cache.
//
// **L'admission** (`admit`) : une nouvelle lecture qui aurait à convertir n'est admise que si les lectures qui
// convertissent restent sous `LUMEN_AUDIO_MAX_SESSIONS`, si l'attente des demandes (90ᵉ centile sur 60 s) reste
// sous une seconde, et si la machine n'est pas saturée (charge moyenne par fil). Sinon l'éligibilité répond
// `son-serveur-occupe` et le lecteur actuel prend le titre : **on refuse les nouvelles avant de dégrader les
// anciennes**. La bascule en cours de lecture viendra avec l'hôte client (étape 4) ; ce qu'elle lira est déjà là
// (`audioState` : l'avance convertie et l'état « ok » / « tension » d'une lecture).

import { loadavg, availableParallelism } from "node:os";
import { join } from "node:path";
import { config } from "@/lib/config";
import { DATA_DIR } from "@/lib/dataDir";
import { LumenError, type LumenAudioTrack, type LumenIndex } from "../format";
import { convertRange, type ConvertFacts, type DialogueRun } from "./convert";
import { DiskTier, keyString, MemoryTier, relativePathOf, type ConvertKey } from "./convertCache";
import { targetTag } from "./convertGrid";
import type { AudioFeed, AudioFeedSpec } from "./feed";
import { targetById } from "./view";
import { ffmpegPool } from "./ffmpegPool";

/**
 * Le pool de ffmpeg pré-lancés (`ffmpegPool.ts`) sert-il les conversions quand rien ne le demande ? Décidé par la
 * mesure du 17/11/2026 (DECISIONS §163) ; une lecture de la page de banc le choisit pour elle (`setPlaybackMode`).
 */
export const POOL_DEFAULT = false;

/** Les modes d'essai d'une lecture (page `/lumen-test`) : le pool, et la lecture froide (sans le cache). */
export interface PlaybackMode {
  pool?: boolean;
  /** Ne rien lire du cache (mémoire, disque) : chaque segment converti pour cette lecture, pour comparer à froid. */
  cold?: boolean;
  /** `false` : aucune avance pour cette lecture (le banc, pour mesurer une demande seule). */
  lead?: boolean;
}

/** L'avance de conversion sur la tête de lecture, et la taille d'une tâche d'avance (5-conversion-son.md §5.5). */
export const LEAD_US = 120_000_000;
export const LEAD_TASK_US = 60_000_000;
/**
 * Une tâche d'avance « dialogues » (§191) : 30 s. Son PCM décodé passe par Node (≈ 1,2 Mo par seconde en 5.1), et
 * chaque segment est traité depuis ses 6 s de pré-roulement : 30 s tiennent ~45 Mo et ~1,5 s de calcul.
 */
export const DIALOGUE_LEAD_TASK_US = 30_000_000;
/** Une lecture sans requête depuis deux minutes ne convertit plus rien d'avance, et ne compte plus à l'admission. */
export const SESSION_IDLE_MS = 2 * 60_000;
/** Au-delà, une demande répond « occupé » (503) : le lecteur réessaie, la conversion continue. */
export const DEMAND_BUDGET_MS = 8_000;
/** Délai maximal d'un processus ffmpeg : une demande (un segment), une tâche d'avance (60 s de son). */
export const DEMAND_TIMEOUT_MS = 30_000;
export const LEAD_TIMEOUT_MS = 120_000;
/** Demandes en attente au plus : au-delà, « occupé » tout de suite. */
export const MAX_DEMAND_QUEUED = 32;
/** L'admission : 90ᵉ centile de l'attente des demandes sur 60 s, et charge moyenne par fil. */
export const ADMIT_WAIT_P90_MS = 1_000;
export const ADMIT_LOAD_PER_THREAD = 3;
/** Ce que l'on garde des conversions pour la Configuration : 24 h, 2 000 au plus. */
const RECENT_MS = 24 * 60 * 60_000;
const RECENT_MAX = 2_000;

export type ConvertPriority = "demand" | "lead";

interface Task {
  priority: ConvertPriority;
  label: string;
  enqueuedAt: number;
  startedAt: number | null;
  /** L'ordre de départ (deux départs dans la même milliseconde se départagent). */
  startedSeq: number;
  controller: AbortController;
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** La file des conversions : bornée, deux priorités, l'avance cède sa place à la demande. */
export class AudioQueue {
  readonly running = new Set<Task>();
  readonly demand: Task[] = [];
  readonly lead: Task[] = [];
  /** Les attentes des demandes (entrée dans la file → départ), pour l'admission. */
  private readonly waits: { at: number; ms: number }[] = [];
  preempted = 0;
  private seq = 0;

  constructor(private readonly maxJobs: () => number) {}

  push(priority: ConvertPriority, label: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (priority === "demand" && this.demand.length >= MAX_DEMAND_QUEUED) return reject(new LumenError("occupe", "File de conversion pleine."));
      const task: Task = { priority, label, enqueuedAt: Date.now(), startedAt: null, startedSeq: 0, controller: new AbortController(), run, resolve, reject };
      (priority === "demand" ? this.demand : this.lead).push(task);
      this.dispatch();
      // Une demande qui ne trouve pas de place prend celle d'une avance : la plus récemment lancée, la moins avancée.
      if (priority === "demand" && this.demand.includes(task)) {
        const leads = [...this.running].filter((t) => t.priority === "lead" && !t.controller.signal.aborted);
        const victim = leads.sort((x, y) => y.startedSeq - x.startedSeq)[0];
        if (victim) {
          this.preempted += 1;
          victim.controller.abort();
        }
      }
    });
  }

  private dispatch(): void {
    while (this.running.size < Math.max(1, this.maxJobs())) {
      const task = this.demand.shift() ?? this.lead.shift();
      if (!task) return;
      task.startedAt = Date.now();
      task.startedSeq = ++this.seq;
      if (task.priority === "demand") this.noteWait(task.startedAt, task.startedAt - task.enqueuedAt);
      this.running.add(task);
      task
        .run(task.controller.signal)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running.delete(task);
          this.dispatch();
        });
    }
  }

  /** Retire les avances encore en attente d'une lecture (elle s'est arrêtée, ou a sauté ailleurs). */
  dropLead(label: string): void {
    for (let i = this.lead.length - 1; i >= 0; i--) {
      if (this.lead[i].label === label) {
        const [task] = this.lead.splice(i, 1);
        task.reject(new LumenError("occupe", "Avance abandonnée."));
      }
    }
  }

  private noteWait(at: number, ms: number): void {
    this.waits.push({ at, ms });
    while (this.waits.length > 0 && at - this.waits[0].at > 60_000) this.waits.shift();
  }

  /** Le 90ᵉ centile de l'attente des demandes sur la dernière minute (0 sans demande). */
  waitP90(now = Date.now()): number {
    const recent = this.waits.filter((w) => now - w.at <= 60_000).map((w) => w.ms).sort((a, b) => a - b);
    if (recent.length === 0) return 0;
    return recent[Math.min(recent.length - 1, Math.floor(recent.length * 0.9))];
  }

  get stats(): { running: number; runningLead: number; demandQueued: number; leadQueued: number; preempted: number } {
    return {
      running: this.running.size,
      runningLead: [...this.running].filter((t) => t.priority === "lead").length,
      demandQueued: this.demand.length,
      leadQueued: this.lead.length,
      preempted: this.preempted,
    };
  }
}

/** D'où vient un segment converti remis : ce que le relevé de la lecture compte. */
export type ConvertedFrom = "ram" | "disk" | "built" | "shared";

export interface ConvertedSegment {
  bytes: Uint8Array;
  from: ConvertedFrom;
  /** Attente dans la file (fabriqué) ou derrière la conversion en vol (partagé). */
  waitMs: number;
  /** ffmpeg (fabriqué). */
  convMs: number;
  /** Lecture du fichier par le fil de calcul (fabriqué). */
  feedMs: number;
  /** Fabriqué : du don des données au premier octet de ffmpeg, et servi par le pool ou non. */
  firstByteMs?: number | null;
  pooled?: boolean;
}

/** Une lecture qui convertit : ce que l'avance et l'admission en savent. */
interface Session {
  key: string;
  version: string;
  track: number;
  index: LumenIndex;
  source: NonNullable<LumenAudioTrack["convert"]>;
  target: string;
  cid: string;
  lastN: number;
  lastAt: number;
  leading: boolean;
  readFeed: FeedReader;
  /** Un rendu « dialogues » (§191) : son traitement, que l'avance refait pour chaque tâche. */
  dialogue?: DialogueRun;
}

export type FeedReader = (spec: AudioFeedSpec) => Promise<{ feed: AudioFeed | null; diskMs: number; ms: number }>;

export interface ConvertRequest {
  index: LumenIndex;
  /** `lumenVersionOf(index)`. */
  version: string;
  /** La piste telle que la vue la sert (`converted` posé). */
  track: LumenAudioTrack;
  n: number;
  readFeed: FeedReader;
  /** La lecture (`compte\0s`) : pour l'avance et l'admission ; sans elle (préparation anonyme), ni l'une ni l'autre. */
  session?: string;
  /**
   * Un rendu « dialogues » (§191) : `track` est la vue `dialogueTrackView` (convertie sous l'identité du traitement),
   * et la conversion passe le PCM par `DialogueEnhancer` (`convertDialogueRange`). Jamais par le pool.
   */
  dialogue?: DialogueRun;
}

interface Recent {
  at: number;
  ms: number;
  segments: number;
  priority: ConvertPriority;
}

export class LumenAudio {
  readonly memory = new MemoryTier(() => config.lumen.audioRamMb * 1024 * 1024);
  readonly disk: DiskTier;
  readonly queue = new AudioQueue(() => config.lumen.audioMaxJobs);
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  readonly sessions = new Map<string, Session>();
  /** Les lectures admises qui n'ont pas encore demandé de segment converti : comptées deux minutes. */
  private readonly admitted = new Map<string, number>();
  readonly totals = { built: 0, ram: 0, disk: 0, shared: 0, busy: 0, failures: 0, refusedAdmissions: 0 };
  private readonly recent: Recent[] = [];
  private readonly modes = new Map<string, PlaybackMode & { at: number }>();

  /** Les modes d'essai d'une lecture (`?convPool=`, `?convCold=` d'`eligibility`/`prepare`), six heures au plus. */
  setPlaybackMode(key: string, mode: PlaybackMode, now = Date.now()): void {
    this.modes.set(key, { ...mode, at: now });
    for (const [k, m] of this.modes) if (now - m.at > 6 * 3_600_000) this.modes.delete(k);
    while (this.modes.size > 300) this.modes.delete(this.modes.keys().next().value!);
  }

  modeOf(key: string | undefined): PlaybackMode {
    return (key && this.modes.get(key)) || {};
  }

  private usePool(key: string | undefined): boolean {
    return this.modeOf(key).pool ?? POOL_DEFAULT;
  }

  constructor(dir: string) {
    this.disk = new DiskTier(dir, () => config.lumen.audioCacheGb * 1024 ** 3);
  }

  /** Le segment converti `n` de la piste : en mémoire, sur le disque, en vol, ou fabriqué (une demande). */
  async segment(req: ConvertRequest): Promise<ConvertedSegment> {
    const conv = req.track.converted;
    const source = req.track.convert;
    if (!conv || !source) throw new LumenError("piste-inconnue", "Piste non convertie.");
    const key = this.keyOf(req.version, req.track.number, conv.target, conv.cid, req.n);
    if (req.session) this.noteHead(req, req.session);
    const ks = keyString(key);
    const cold = this.modeOf(req.session).cold === true;
    const held = cold ? null : this.memory.get(ks);
    if (held) {
      this.totals.ram += 1;
      return { bytes: held, from: "ram", waitMs: 0, convMs: 0, feedMs: 0 };
    }
    const rel = relativePathOf(key);
    const pending = this.inflight.get(ks);
    if (!pending && rel && !cold) {
      const kept = await this.disk.get(rel);
      if (kept) {
        this.memory.put(ks, kept);
        this.totals.disk += 1;
        return { bytes: kept, from: "disk", waitMs: 0, convMs: 0, feedMs: 0 };
      }
    }
    const began = performance.now();
    const shared = this.inflight.get(ks);
    if (shared) {
      try {
        const bytes = await withBudget(shared);
        this.totals.shared += 1;
        return { bytes, from: "shared", waitMs: Math.round(performance.now() - began), convMs: 0, feedMs: 0 };
      } catch (error) {
        // Une avance tuée pour céder sa place, ou abandonnée : la demande fait le segment elle-même. Le budget de
        // la demande dépassé, lui, remonte (« occupé »).
        if (!(error instanceof LumenError && error.code === "occupe" && error.message !== BUDGET_MESSAGE)) throw error;
      }
    }
    let facts: ConvertFacts | null = null;
    let startedAt = 0;
    const work = this.run("demand", req.index, req.version, req.track.number, source, conv.target, conv.cid, req.n, req.n + 1, req.readFeed, (f, s) => {
      facts = f;
      startedAt = s;
    }, "", this.usePool(req.session), req.dialogue);
    const bytes = await withBudget(work.get(req.n) as Promise<Uint8Array>).catch((error) => {
      if (error instanceof LumenError && error.code === "occupe") this.totals.busy += 1;
      throw error;
    });
    const total = Math.round(performance.now() - began);
    const f = facts as ConvertFacts | null;
    return {
      bytes,
      from: "built",
      waitMs: startedAt ? Math.max(0, Math.round(startedAt - began)) : total,
      convMs: f?.ffmpegMs ?? 0,
      feedMs: f?.feedMs ?? 0,
      firstByteMs: f?.firstByteMs ?? null,
      pooled: f?.pooled ?? false,
    };
  }

  keyOf(version: string, track: number, targetId: string, cid: string, n: number): ConvertKey {
    const target = targetById(targetId);
    return { version, track, target: target ? targetTag(target) : targetId, cid, n };
  }

  /**
   * Une conversion [n0, n1) dans la file. Rend une promesse par segment, posée tout de suite dans les conversions
   * en vol (une demande du même segment l'attend au lieu d'en lancer une autre) ; les segments faits vont en
   * mémoire et sur le disque.
   */
  private run(
    priority: ConvertPriority,
    index: LumenIndex,
    version: string,
    track: number,
    source: NonNullable<LumenAudioTrack["convert"]>,
    targetId: string,
    cid: string,
    n0: number,
    n1: number,
    readFeed: FeedReader,
    onFacts?: (facts: ConvertFacts, startedAt: number) => void,
    label = "",
    pooled = POOL_DEFAULT,
    dialogue?: DialogueRun
  ): Map<number, Promise<Uint8Array>> {
    const target = targetById(targetId);
    const out = new Map<number, Promise<Uint8Array>>();
    const settle = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void }>();
    for (let n = n0; n < n1; n++) {
      const ks = keyString(this.keyOf(version, track, targetId, cid, n));
      const promise = new Promise<Uint8Array>((resolve, reject) => settle.set(n, { resolve, reject }));
      promise.catch(() => {}); // une avance abandonnée sans personne pour l'attendre
      out.set(n, promise);
      this.inflight.set(ks, promise);
      void promise.finally(() => {
        if (this.inflight.get(ks) === promise) this.inflight.delete(ks);
      }).catch(() => {});
    }
    const fail = (error: unknown) => {
      for (const s of settle.values()) s.reject(error);
    };
    if (!target) {
      fail(new Error(`Cible inconnue : ${targetId}`));
      return out;
    }
    void this.queue
      .push(priority, label, async (signal) => {
        const startedAt = performance.now();
        const began = Date.now();
        try {
          const result = await convertRange({
            index,
            track,
            source,
            target,
            n0,
            n1,
            ffmpegPath: config.lumen.ffmpegPath,
            readFeed,
            niceness: priority === "demand" ? 10 : 15,
            timeoutMs: priority === "demand" ? DEMAND_TIMEOUT_MS : LEAD_TIMEOUT_MS,
            signal,
            ...(dialogue ? { dialogue } : pooled ? { pool: ffmpegPool(() => config.lumen.ffmpegPath) } : {}),
          });
          onFacts?.(result.facts, startedAt);
          this.noteRecent({ at: began, ms: Math.round(performance.now() - startedAt), segments: n1 - n0, priority });
          this.totals.built += n1 - n0;
          for (const [n, bytes] of result.segments) {
            const key = this.keyOf(version, track, targetId, cid, n);
            this.memory.put(keyString(key), bytes);
            const rel = relativePathOf(key);
            if (rel) void this.disk.put(rel, bytes);
            settle.get(n)?.resolve(bytes);
          }
        } catch (error) {
          const aborted = signal.aborted;
          if (!aborted) this.totals.failures += 1;
          fail(aborted ? new LumenError("occupe", "Conversion cédée à une demande.") : error);
          if (!aborted) throw error;
        }
      })
      .catch(fail);
    return out;
  }

  private noteRecent(r: Recent): void {
    this.recent.push(r);
    while (this.recent.length > RECENT_MAX || (this.recent.length > 0 && r.at - this.recent[0].at > RECENT_MS)) this.recent.shift();
  }

  // ── L'avance ──

  private noteHead(req: ConvertRequest, key: string): void {
    const conv = req.track.converted!;
    const now = Date.now();
    const held = this.sessions.get(key);
    // Une autre piste, un autre fichier : l'avance d'avant est abandonnée.
    if (held && (held.version !== req.version || held.track !== req.track.number || held.cid !== conv.cid)) this.queue.dropLead(held.key);
    this.admitted.delete(key);
    this.sessions.set(key, {
      key,
      version: req.version,
      track: req.track.number,
      index: req.index,
      source: req.track.convert!,
      target: conv.target,
      cid: conv.cid,
      lastN: req.n,
      lastAt: now,
      leading: held?.leading ?? false,
      readFeed: req.readFeed,
      ...(req.dialogue ? { dialogue: req.dialogue } : {}),
    });
    this.sweepSessions(now);
    // Après la réponse : l'avance ne doit pas retarder le segment demandé.
    if (this.modeOf(key).lead !== false) setImmediate(() => this.pumpLead());
  }

  private sweepSessions(now: number): void {
    for (const [key, s] of this.sessions) {
      if (now - s.lastAt > SESSION_IDLE_MS) {
        this.sessions.delete(key);
        this.queue.dropLead(key);
      }
    }
    for (const [key, at] of this.admitted) if (now - at > SESSION_IDLE_MS) this.admitted.delete(key);
  }

  /** Les segments à convertir d'avance pour une lecture : la première suite manquante, 60 s au plus. */
  leadPlan(s: Pick<Session, "index" | "version" | "track" | "target" | "cid" | "lastN"> & Partial<Pick<Session, "dialogue">>): [number, number] | null {
    const segs = s.index.segments;
    const taskUs = s.dialogue ? DIALOGUE_LEAD_TASK_US : LEAD_TASK_US;
    const horizon = segs[s.lastN].startUs + LEAD_US;
    let n0 = -1;
    for (let n = s.lastN + 1; n < segs.length && segs[n].startUs < horizon; n++) {
      const key = this.keyOf(s.version, s.track, s.target, s.cid, n);
      const ks = keyString(key);
      const rel = relativePathOf(key);
      const have = this.memory.has(ks) || this.inflight.has(ks) || (rel !== null && this.disk.has(rel));
      if (n0 < 0) {
        if (!have) n0 = n;
        continue;
      }
      if (have || segs[n].startUs - segs[n0].startUs >= taskUs) return [n0, n];
    }
    if (n0 < 0) return null;
    let n1 = n0 + 1;
    while (n1 < segs.length && segs[n1].startUs < horizon && segs[n1].startUs - segs[n0].startUs < taskUs) n1++;
    return [n0, n1];
  }

  /** Lance l'avance des lectures actives qui n'en ont pas une en cours. */
  pumpLead(now = Date.now()): void {
    this.sweepSessions(now);
    void this.disk.scan();
    for (const s of this.sessions.values()) {
      if (s.leading || now - s.lastAt > SESSION_IDLE_MS || this.modeOf(s.key).lead === false) continue;
      const plan = this.leadPlan(s);
      if (!plan) continue;
      s.leading = true;
      const parts = this.run("lead", s.index, s.version, s.track, s.source, s.target, s.cid, plan[0], plan[1], s.readFeed, undefined, s.key, this.usePool(s.key), s.dialogue);
      void Promise.allSettled([...parts.values()]).then(() => {
        const held = this.sessions.get(s.key);
        if (held) held.leading = false;
        setImmediate(() => this.pumpLead());
      });
    }
  }

  // ── L'admission ──

  /** Les lectures qui convertissent (une requête de moins de deux minutes) ou viennent d'être admises. */
  activeSessions(now = Date.now()): number {
    let count = 0;
    for (const s of this.sessions.values()) if (now - s.lastAt <= SESSION_IDLE_MS) count += 1;
    for (const [key, at] of this.admitted) if (now - at <= SESSION_IDLE_MS && !this.sessions.has(key)) count += 1;
    return count;
  }

  /** Une lecture qui aurait à convertir peut-elle commencer ? Une lecture déjà en cours l'est toujours. */
  admit(key: string, now = Date.now(), load: number = loadavg()[0] / Math.max(1, availableParallelism())): { ok: true } | { ok: false; detail: string } {
    this.sweepSessions(now);
    if (this.sessions.has(key) || this.admitted.has(key)) {
      this.admitted.set(key, now);
      return { ok: true };
    }
    const max = config.lumen.audioMaxSessions;
    const active = this.activeSessions(now);
    let refusal: string | null = null;
    if (active >= max) refusal = `${active} lectures convertissent (au plus ${max})`;
    else if (this.queue.waitP90(now) > ADMIT_WAIT_P90_MS) refusal = `attente de conversion ${this.queue.waitP90(now)} ms (90ᵉ centile)`;
    else if (load > ADMIT_LOAD_PER_THREAD) refusal = `machine chargée (${load.toFixed(1)} par fil)`;
    if (refusal) {
      this.totals.refusedAdmissions += 1;
      return { ok: false, detail: refusal };
    }
    this.admitted.set(key, now);
    return { ok: true };
  }

  /**
   * L'état d'une lecture qui convertit, pour la bascule en cours de lecture (étape 4) : l'avance convertie devant
   * le dernier segment demandé, et « tension » quand elle tombe sous 30 s pendant que des demandes attendent.
   */
  audioState(key: string): { state: "ok" | "tension"; leadS: number } | null {
    const s = this.sessions.get(key);
    if (!s) return null;
    const segs = s.index.segments;
    let leadUs = 0;
    for (let n = s.lastN + 1; n < segs.length; n++) {
      const k = this.keyOf(s.version, s.track, s.target, s.cid, n);
      const rel = relativePathOf(k);
      if (!this.memory.has(keyString(k)) && !(rel && this.disk.has(rel))) break;
      leadUs += segs[n].endUs - segs[n].startUs;
    }
    const leadS = Math.round(leadUs / 1e5) / 10;
    return { state: leadS < 30 && this.queue.demand.length > 0 ? "tension" : "ok", leadS };
  }

  /** Pour la Configuration : la file, les lectures, le cache, et les 24 dernières heures. */
  status(now = Date.now()) {
    // L'occupation du disque se relit une fois (au premier usage) : la Configuration la montre dès sa deuxième lecture.
    void this.disk.scan();
    const day = this.recent.filter((r) => now - r.at <= RECENT_MS);
    const perSegment = day.filter((r) => r.priority === "demand").map((r) => r.ms).sort((a, b) => a - b);
    return {
      queue: this.queue.stats,
      sessions: this.activeSessions(now),
      memory: { segments: this.memory.size, bytes: this.memory.bytes, capBytes: config.lumen.audioRamMb * 1024 * 1024 },
      disk: { ...this.disk.stats, dir: this.disk.dir, capBytes: config.lumen.audioCacheGb * 1024 ** 3 },
      totals: { ...this.totals },
      day: {
        conversions: day.length,
        segments: day.reduce((n, r) => n + r.segments, 0),
        demandMedianMs: perSegment.length ? perSegment[perSegment.length >> 1] : null,
        demandMaxMs: perSegment.length ? perSegment[perSegment.length - 1] : null,
      },
    };
  }
}

const BUDGET_MESSAGE = "Segment converti trop long à venir.";

/** Attend `work`, au plus `DEMAND_BUDGET_MS` : au-delà, « occupé ». */
function withBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new LumenError("occupe", BUDGET_MESSAGE)), DEMAND_BUDGET_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

const STATE = Symbol.for("cine-app.lumenServer.audio");

/** Le dossier du cache disque : `LUMEN_AUDIO_CACHE_DIR`, sinon `DATA_DIR/lumen-audio`. */
export function lumenAudioCacheDir(): string {
  return config.lumen.audioCacheDir.trim() || join(DATA_DIR, "lumen-audio");
}

/** L'état de la conversion du processus, créé à la première demande. */
export function lumenAudio(): LumenAudio {
  const g = globalThis as unknown as Record<symbol, LumenAudio | undefined>;
  return (g[STATE] ??= new LumenAudio(lumenAudioCacheDir()));
}

/** Oublie l'état (tests). */
export function resetLumenAudio(): void {
  const g = globalThis as unknown as Record<symbol, LumenAudio | undefined>;
  g[STATE] = undefined;
}
