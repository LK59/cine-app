import { normaliseLanguage } from "@/lib/trackPreferences";
import type { ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";
import {
  createJob,
  fetchExternalSubtitles,
  fetchOptions,
  pollJob,
  resumeJob,
  SubtitleGenError,
  type JobStatus,
  type PollAnswer,
  type SubtitleGenErrorCode,
  type SubtitleGenOptions,
} from "./client";
import { GeneratedCues } from "./generatedCues";

/**
 * « Générer des sous-titres », côté lecteur natif : ce que le serveur fait pour ce titre, et ce que
 * le lecteur en montre (DECISIONS.md §70).
 *
 * Un objet par hôte natif, comme `lifecycle` et `seeks` — au-dessus des chaînes de lecture : une
 * reconstruction (coupure, piste audio, dialogues) ne perd ni les lignes déjà reçues ni le sondage.
 * Sans React : l'hôte le lit par `subscribe` / `snapshot`, et les tests le pilotent sans navigateur.
 *
 * Ce qu'il possède :
 *  - les générations du titre (`/options.jobs`, puis celles qu'on demande), chacune avec ses lignes ;
 *  - la piste **active** — celle que le spectateur a choisie dans le menu —, la seule qu'on sonde, et
 *    **toujours avec la position** de la tête : c'est elle qui dit au serveur quoi traduire d'abord ;
 *  - la fin : sondage lent tant que Jellyfin ne présente pas le fichier, puis la liste des externes
 *    relue, et la main rendue à l'hôte (`onFinal`) pour basculer sur la piste « générée ».
 *
 * **Rien ici ne lève vers le lecteur** : chaque échec est un code (`onError`) que l'hôte dit en
 * message passager — une génération qui échoue ne doit jamais devenir une lecture qui échoue.
 */

/** Une génération telle que le menu et l'affichage la voient. */
export interface GenerationView {
  /** Le numéro de l'entrée temporaire dans le menu — voir `isGeneratingTrack`. */
  id: number;
  jobId: string;
  target: string;
  status: JobStatus;
  done: number;
  total: number;
  reason?: string;
  presented: boolean;
  /** La piste finale a pris sa place : l'entrée temporaire n'a plus lieu d'être. */
  finalized: boolean;
}

export interface GenerationSnapshot {
  /** `null` tant que `/options` n'a pas répondu ; `enabled: false` s'il a échoué. */
  options: Pick<SubtitleGenOptions, "enabled" | "targets" | "existing" | "quota"> | null;
  jobs: readonly GenerationView[];
  active: string | null;
  /** Une demande en vol : le menu ne la propose pas deux fois. */
  requesting: string | null;
}

/** Ce qu'un instant sans ligne traduite affiche à la place, comme un sous-titre. */
export type GenerationNotice = { kind: "preparing" } | { kind: "resuming" } | { kind: "paused"; reason: string | null };

/**
 * Les entrées temporaires ont des numéros à part : les pistes du fichier sont positives, les
 * fichiers à côté du film valent −1 − leur index Jellyfin (quelques dizaines au plus). Un million
 * plus bas, aucune collision possible — et `isExternalTrack` (négatif) les tient déjà hors du
 * pipeline, qui ne doit jamais recevoir un numéro qui n'est pas le sien.
 */
const GENERATING_BASE = -1_000_000;
export function isGeneratingTrack(id: number | null | undefined): id is number {
  return typeof id === "number" && id <= GENERATING_BASE;
}

/** Sondage d'une génération active qui avance. */
export const POLL_MS = 2_000;
/** En pause, finie mais pas encore présentée par Jellyfin : rien ne presse. */
export const SLOW_POLL_MS = 10_000;
/**
 * Un fichier final donné sans que Jellyfin le présente : le repli du serveur (une copie gardée chez
 * lui). Il finira dans la liste des externes lui aussi ; on la relit à partir de là.
 */
export const FALLBACK_FILE_AFTER_MS = 60_000;
/** La liste des externes n'est pas relue plus souvent que cela. */
const EXTERNALS_EVERY_MS = 30_000;

/**
 * Ce que l'hôte fournit et qui change de rendu en rendu — remplacé par `setHooks`, jamais figé à la
 * construction : l'objet naît dans un initialiseur d'état, avant que ce que ces rappels lisent existe.
 */
export interface GenerationHooks {
  /** Où en est le film — la cible d'un saut pas encore atteint comprise. */
  position: () => number;
  /** Une ligne `subtitle-gen` au journal du lecteur. */
  log: (fields: Record<string, unknown>) => void;
  /** Un échec à dire au spectateur. */
  onError: (code: SubtitleGenErrorCode | "job-failed", facts: { target: string | null; quotaLimit: number | null }) => void;
  /** Jellyfin présente le fichier : la liste des externes relue, et l'entrée générée de la langue. */
  onFinal: (target: string, source: ExternalSubtitleSource, externals: ExternalSubtitleSource[]) => void;
  /** La génération active a échoué : l'hôte retire la piste. */
  onFailed?: (target: string) => void;
}

export interface GenerationDeps extends Partial<GenerationHooks> {
  itemId: string;
  sessionId?: string;
  now?: () => number;
  /** Pour les tests : la page est-elle visible ? Par défaut, `document.visibilityState`. */
  visible?: () => boolean;
}

interface Job {
  view: GenerationView;
  cues: GeneratedCues;
  rev: number;
  fileUrl?: string;
  doneAt: number | null;
  externalsAt: number;
}

const sameLanguage = (a: string | null | undefined, b: string | null | undefined) => {
  const x = normaliseLanguage(a);
  return x !== null && x === normaliseLanguage(b);
};

export class SubtitleGeneration {
  private readonly listeners = new Set<() => void>();
  private snap: GenerationSnapshot = { options: null, jobs: [], active: null, requesting: null };
  private readonly jobs = new Map<string, Job>();
  private readonly ids = new Map<string, number>();
  private active: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: AbortController | null = null;
  private aborter = new AbortController();
  /** Fermé tant que `open` n'a pas été appelé, et de nouveau après `close`. */
  private destroyed = true;
  private quotaLimit: number | null = null;
  /** Le clic « Générer » (ou la réactivation) : la première ligne affichée est comptée de là. */
  private firstLineFrom: number | null = null;
  /** Un saut qui a atterri dans une zone pas encore traduite : quand, et où. */
  private seekGap: { at: number; since: number } | null = null;
  private readonly now: () => number;
  private readonly visible: () => boolean;
  private readonly onVisibility = () => {
    if (this.visible()) this.pollSoon(0);
    else this.clearTimer();
  };

  private hooks: GenerationHooks;

  constructor(private readonly deps: GenerationDeps) {
    this.hooks = {
      position: deps.position ?? (() => 0),
      log: deps.log ?? (() => {}),
      onError: deps.onError ?? (() => {}),
      onFinal: deps.onFinal ?? (() => {}),
      onFailed: deps.onFailed,
    };
    this.now = deps.now ?? Date.now;
    this.visible = deps.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  }

  /**
   * Ouvre : écoute la visibilité de la page, lit `/options`, et reprend le sondage d'une piste qui
   * était active. Réversible, comme `close` : le double montage du mode strict ferme puis rouvre le
   * même objet, et un objet détruit pour de bon aurait laissé le second montage sans génération.
   */
  open(): Promise<void> {
    if (!this.destroyed) return Promise.resolve();
    this.destroyed = false;
    this.aborter = new AbortController();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
    if (this.active) this.pollSoon(0);
    return this.load();
  }

  setHooks(hooks: Partial<GenerationHooks>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): GenerationSnapshot => this.snap;

  private emit(): void {
    this.snap = {
      options: this.snap.options,
      jobs: [...this.jobs.values()].map((job) => ({ ...job.view })),
      active: this.active,
      requesting: this.snap.requesting,
    };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Un abonné qui lève n'arrête ni les autres ni le sondage.
      }
    }
  }

  private setOptions(options: GenerationSnapshot["options"]): void {
    this.snap = { ...this.snap, options };
  }

  private idFor(target: string): number {
    const key = normaliseLanguage(target) ?? target;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = GENERATING_BASE - this.ids.size;
      this.ids.set(key, id);
    }
    return id;
  }

  /** La génération d'une langue — par numéro d'entrée ou par code. */
  private jobOf(target: string | null): Job | null {
    if (!target) return null;
    for (const job of this.jobs.values()) if (sameLanguage(job.view.target, target)) return job;
    return null;
  }

  targetOf(id: number): string | null {
    for (const job of this.jobs.values()) if (job.view.id === id) return job.view.target;
    return null;
  }

  private remember(raw: { jobId: string; target: string; status: JobStatus; done?: number; total?: number; reason?: string; presented?: boolean }): Job {
    const existing = this.jobOf(raw.target);
    if (existing && existing.view.jobId === raw.jobId) {
      existing.view = {
        ...existing.view,
        status: raw.status,
        done: raw.done ?? existing.view.done,
        total: raw.total ?? existing.view.total,
        reason: raw.reason,
        presented: raw.presented ?? existing.view.presented,
      };
      return existing;
    }
    if (existing) this.jobs.delete(existing.view.jobId);
    const job: Job = {
      view: {
        id: this.idFor(raw.target),
        jobId: raw.jobId,
        target: raw.target,
        status: raw.status,
        done: raw.done ?? 0,
        total: raw.total ?? 0,
        ...(raw.reason ? { reason: raw.reason } : {}),
        presented: raw.presented ?? false,
        finalized: false,
      },
      cues: new GeneratedCues(),
      rev: 0,
      doneAt: raw.status === "done" ? this.now() : null,
      externalsAt: 0,
    };
    this.jobs.set(raw.jobId, job);
    return job;
  }

  /** Ce que le serveur propose pour ce titre, et les générations déjà en cours — une fois, à l'ouverture. */
  async load(): Promise<void> {
    try {
      const options = await fetchOptions(this.deps.itemId, this.aborter.signal);
      if (this.destroyed) return;
      this.quotaLimit = options.quota.limit || null;
      this.setOptions({ enabled: options.enabled, targets: options.targets, existing: options.existing, quota: options.quota });
      for (const job of options.jobs) if (job.status !== "failed") this.remember(job);
    } catch {
      // Une version du serveur sans ces routes, un réseau absent : rien n'est proposé, et rien
      // n'est dit — le spectateur n'a rien demandé.
      if (this.destroyed) return;
      this.setOptions({ enabled: false, targets: [], existing: [], quota: { used: 0, limit: 0 } });
    }
    this.emit();
  }

  /** Demande une génération, puis l'active. Rend le numéro de son entrée, ou `null` si elle n'a pas pu partir. */
  async generate(target: string): Promise<number | null> {
    if (this.destroyed || this.snap.requesting) return null;
    const clickedAt = this.now();
    const position = this.safePosition();
    this.snap = { ...this.snap, requesting: target };
    this.emit();
    this.hooks.log({ event: "demande", target, at: position });
    try {
      const created = await createJob({ itemId: this.deps.itemId, target, position }, this.aborter.signal);
      if (this.destroyed) return null;
      const job = this.remember({ jobId: created.jobId, target, status: created.status });
      this.snap = { ...this.snap, requesting: null };
      this.activate(job.view.id, clickedAt);
      return job.view.id;
    } catch (error) {
      if (this.destroyed) return null;
      this.snap = { ...this.snap, requesting: null };
      const code: SubtitleGenErrorCode = error instanceof SubtitleGenError ? error.code : "failed";
      if (code === "exists") {
        // Elle existe déjà — lancée sur un autre appareil, ou ici avant un rechargement : on la
        // reprend telle qu'elle est plutôt que de dire non.
        await this.load();
        const job = this.jobOf(target);
        if (job && !this.destroyed) {
          this.activate(job.view.id, clickedAt);
          return job.view.id;
        }
      }
      this.hooks.log({ event: "erreur", target, code });
      this.emit();
      this.hooks.onError(code, { target, quotaLimit: this.quotaLimit });
      return null;
    }
  }

  /**
   * La piste choisie dans le menu : une entrée temporaire l'active, toute autre la désactive. Les
   * lignes déjà reçues restent ; une piste réactivée dans un nouvel hôte part de `since: 0`.
   */
  activate(id: number | null, clickedAt = this.now()): void {
    const target = id === null ? null : this.targetOf(id);
    if (target === this.active) return;
    this.active = target;
    this.seekGap = null;
    this.firstLineFrom = target ? clickedAt : null;
    this.clearTimer();
    this.inflight?.abort();
    this.inflight = null;
    if (target) {
      const job = this.jobOf(target);
      this.hooks.log({ event: "activation", target, status: job?.view.status ?? "?", known: job?.cues.count ?? 0 });
      this.pollSoon(0);
    }
    this.emit();
  }

  get activeTarget(): string | null {
    return this.active;
  }

  textAt(seconds: number): string | null {
    return this.jobOf(this.active)?.cues.textAt(seconds) ?? null;
  }

  /** Ce qu'afficher à un instant **sans** ligne traduite — `null` dans une zone faite. */
  noticeAt(seconds: number): GenerationNotice | null {
    const job = this.jobOf(this.active);
    if (!job || job.view.finalized) return null;
    const { status } = job.view;
    if (status === "done" || status === "failed") return null;
    if (job.cues.covers(seconds, job.view.total)) return null;
    if (status === "paused" || status === "stale") return { kind: "paused", reason: job.view.reason ?? null };
    if (status === "preparing" || job.cues.count === 0) return { kind: "preparing" };
    return this.seekGap ? { kind: "resuming" } : { kind: "preparing" };
  }

  /**
   * Une vraie ligne vient d'être affichée : la première depuis le clic, ou la première après un saut
   * dans une zone pas encore faite — les deux attentes que le journal mesure.
   */
  noteShown(): void {
    const target = this.active;
    if (!target) return;
    const now = this.now();
    if (this.firstLineFrom !== null) {
      this.hooks.log({ event: "première-ligne", target, ms: now - this.firstLineFrom, at: this.safePosition() });
      this.firstLineFrom = null;
    }
    if (this.seekGap) {
      this.hooks.log({ event: "saut-non-traduit", target, at: this.seekGap.at, waitMs: now - this.seekGap.since });
      this.seekGap = null;
    }
  }

  /** Un saut demandé : le serveur l'apprend tout de suite, et un saut dans le vide est mesuré. */
  noteSeek(seconds: number): void {
    const job = this.jobOf(this.active);
    if (!job || job.view.finalized || job.view.status === "done") return;
    this.seekGap = job.cues.covers(seconds, job.view.total) ? null : { at: Math.round(seconds), since: this.now() };
    this.pollSoon(0);
  }

  /** « Reprendre la génération » : pour une génération en pause. */
  async resume(target: string): Promise<void> {
    const job = this.jobOf(target);
    if (!job || this.destroyed) return;
    this.hooks.log({ event: "reprise", target, reason: job.view.reason ?? "" });
    try {
      await resumeJob(job.view.jobId, this.aborter.signal);
      if (this.destroyed) return;
      job.view = { ...job.view, status: "running", reason: undefined };
      this.emit();
      if (this.active && sameLanguage(this.active, target)) this.pollSoon(0);
    } catch (error) {
      if (this.destroyed) return;
      const code: SubtitleGenErrorCode = error instanceof SubtitleGenError ? error.code : "failed";
      this.hooks.log({ event: "erreur", target, code });
      this.hooks.onError(code, { target, quotaLimit: this.quotaLimit });
    }
  }

  /** La piste finale a pris la place de l'entrée temporaire. */
  finalize(target: string): void {
    const job = this.jobOf(target);
    if (!job) return;
    job.view = { ...job.view, finalized: true };
    if (this.active && sameLanguage(this.active, target)) {
      this.active = null;
      this.clearTimer();
    }
    this.emit();
  }

  /** Les lignes reçues d'une génération — pour basculer sur la piste finale sans rien redemander. */
  cuesOf(target: string) {
    return this.jobOf(target)?.cues.cues ?? [];
  }

  /** Le lecteur s'en va : plus de sondage, les requêtes en vol abandonnées. */
  close(): void {
    this.destroyed = true;
    this.clearTimer();
    this.aborter.abort();
    this.inflight?.abort();
    this.inflight = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
  }

  // --- le sondage ---------------------------------------------------------------------------

  private safePosition(): number {
    try {
      const at = this.hooks.position();
      return Number.isFinite(at) ? Math.max(0, Math.round(at * 10) / 10) : 0;
    } catch {
      return 0;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private pollSoon(delay: number): void {
    this.clearTimer();
    if (this.destroyed || !this.active) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce();
    }, delay);
  }

  private delayFor(job: Job): number | null {
    const { status } = job.view;
    if (job.view.finalized || status === "failed") return null;
    if (status === "preparing" || status === "running") return POLL_MS;
    return SLOW_POLL_MS;
  }

  private async pollOnce(): Promise<void> {
    const job = this.jobOf(this.active);
    if (!job || this.destroyed) return;
    // Page cachée : on ne sonde pas. Le retour au premier plan relance tout de suite.
    if (!this.visible()) return;
    this.inflight?.abort();
    const inflight = new AbortController();
    this.inflight = inflight;
    const forward = () => inflight.abort();
    this.aborter.signal.addEventListener("abort", forward);
    let answer: PollAnswer | null = null;
    try {
      answer = await pollJob(
        job.view.jobId,
        { since: job.rev, position: this.safePosition(), ...(this.deps.sessionId ? { sessionId: this.deps.sessionId } : {}) },
        inflight.signal
      );
    } catch {
      // Un sondage manqué n'est pas une panne : le suivant repart de la même révision.
      answer = null;
    } finally {
      this.aborter.signal.removeEventListener("abort", forward);
    }
    if (this.destroyed || inflight.signal.aborted || this.inflight !== inflight) return;
    this.inflight = null;
    // Le spectateur a changé de piste pendant la réponse : elle reste valable pour cette génération.
    if (answer) this.apply(job, answer);
    if (answer && job.view.status === "done" && !job.view.finalized) await this.lookForFinal(job);
    if (this.destroyed) return;
    if (this.jobOf(this.active) !== job) return;
    const delay = this.delayFor(job);
    if (delay !== null) this.pollSoon(delay);
  }

  private apply(job: Job, answer: PollAnswer): void {
    const before = job.view.status;
    job.cues.insert(answer.cues);
    job.rev = answer.rev;
    if (answer.fileUrl) job.fileUrl = answer.fileUrl;
    job.view = {
      ...job.view,
      status: answer.status,
      done: answer.done,
      total: answer.total,
      reason: answer.reason,
      presented: answer.presented,
    };
    if (answer.status === "done" && job.doneAt === null) job.doneAt = this.now();
    if (before !== answer.status) {
      if (answer.status === "paused" || answer.status === "stale") {
        this.hooks.log({ event: "pause", target: job.view.target, status: answer.status, reason: answer.reason ?? "", done: answer.done, total: answer.total });
      } else if (answer.status === "done") {
        this.hooks.log({ event: "fin", target: job.view.target, total: answer.total, presented: answer.presented });
      } else if (answer.status === "failed") {
        this.hooks.log({ event: "échec", target: job.view.target, reason: answer.reason ?? "", done: answer.done, total: answer.total });
        this.hooks.onError("job-failed", { target: job.view.target, quotaLimit: this.quotaLimit });
        if (this.active && sameLanguage(this.active, job.view.target)) {
          this.active = null;
          this.clearTimer();
          this.hooks.onFailed?.(job.view.target);
        }
      }
    }
    this.emit();
  }

  /**
   * Finie : la liste des externes est relue quand Jellyfin présente le fichier — ou, faute de
   * présentation, quand le serveur a donné un fichier depuis longtemps (son repli). Tant que l'entrée
   * générée n'y est pas, l'entrée temporaire reste et le sondage continue, lentement.
   */
  private async lookForFinal(job: Job): Promise<void> {
    const now = this.now();
    const fallback = !!job.fileUrl && job.doneAt !== null && now - job.doneAt >= FALLBACK_FILE_AFTER_MS;
    if (!job.view.presented && !fallback) return;
    // La première relecture tout de suite, les suivantes espacées.
    if (job.externalsAt && now - job.externalsAt < EXTERNALS_EVERY_MS) return;
    job.externalsAt = now;
    let externals: ExternalSubtitleSource[];
    try {
      externals = await fetchExternalSubtitles(this.deps.itemId, this.aborter.signal);
    } catch {
      return;
    }
    if (this.destroyed) return;
    const source = externals.find((s) => s.generated === true && sameLanguage(s.language, job.view.target));
    if (!source) return;
    this.hooks.log({ event: "bascule", target: job.view.target, via: job.view.presented ? "jellyfin" : "repli", afterDoneMs: job.doneAt !== null ? now - job.doneAt : null });
    try {
      this.hooks.onFinal(job.view.target, source, externals);
    } finally {
      this.finalize(job.view.target);
    }
  }
}
