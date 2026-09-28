import { CHUNK_SIZE, type HttpByteSource } from "./byteSource";
import { sourceBufferQuota } from "./bufferBudget";
import { clusterOffsetForTime, type MatroskaFile } from "./matroska";
import { diagRequest, diagReserve } from "./playbackDiagnosis";
import { trace } from "./trace";
import { SESSION_EXPIRED_HEADER } from "@/lib/sessionExpired";
import { coverageFrom } from "@/lib/resumeCache/coverage";

/**
 * La réserve d'avance en mémoire : pendant une lecture, prendre de l'avance quand le lien le permet,
 * au-delà de ce que le tampon du navigateur garde (28/09/2026).
 *
 * Le tampon du navigateur est plafonné — 105 Mo sur iPhone, ~31 s d'un 4K (`bufferBudget.ts`). Cette
 * réserve télécharge plus loin, plus vite que le film, et garde ce qu'elle prend dans la mémoire de
 * la source (`HttpByteSource.offerReserve`), où le lecteur le trouve avant le réseau. Un creux de
 * débit se joue alors sur cette avance.
 *
 * **En mémoire, jamais sur l'appareil.** La première version écrivait l'avance dans l'OPFS
 * (`DiskReserve`, 28/09/2026 au matin) : presque chaque octet du film passait une fois par la mémoire
 * flash — de l'ordre de la taille de ce qu'on regarde, 12 Go par heure de 4K. Retirée le jour même,
 * pour la santé des appareils : l'appareil ne garde que de quoi *démarrer* (`budget.ts`). La réserve
 * est plus petite (`reserveBudgetBytes`), elle disparaît avec la page, et c'est voulu.
 *
 * Ce qu'elle s'interdit — le lecteur passe toujours avant :
 *  - rien tant que le tampon du navigateur n'a pas `MIN_LEAD_SECONDS`, ni pendant qu'une lecture
 *    attend un octet, ni pendant un saut ;
 *  - la page cachée : la réserve est *vidée* — iOS tue d'abord, en arrière-plan, les pages qui
 *    tiennent de la mémoire ;
 *  - rien dans la zone de la lecture en avance du lecteur ; au plus `MAX_AHEAD_SECONDS` de film
 *    devant la tête ;
 *  - un débit borné à `SPEED_FACTOR` fois celui du film, `SPEED_CAP_MBPS` au plus — seule la réserve
 *    est bridée, jamais la lecture.
 */

/** L'avance du navigateur sous laquelle le lien reste tout entier au lecteur. */
export const MIN_LEAD_SECONDS = 10;
/** Requêtes à la fois, au plus. */
export const PARALLEL = 2;
/** Mio par requête, au plus — plus grand que ceux du lecteur, pour remplir un lien rapide malgré l'aller-retour. */
export const RANGE_CHUNKS = 8;
/** Jamais plus que cela de film devant la tête. */
export const MAX_AHEAD_SECONDS = 300;
/** La réserve ne télécharge pas plus vite que ce multiple du débit du film… */
export const SPEED_FACTOR = 4;
/** …ni que ce plafond absolu, en Mb/s. */
export const SPEED_CAP_MBPS = 50;
/** La lecture en avance du lecteur (`PREFETCH_CHUNKS` dans byteSource.ts) : la réserve commence au-delà. */
const PLAYER_READAHEAD_CHUNKS = 6;
const TICK_MS = 1000;
/** Tous les combien une ligne `point` résume la réserve, au journal et dans la trace. */
const REPORT_EVERY_MS = 30_000;
/** Après ces échecs d'affilée, la réserve s'arrête pour la séance. */
const MAX_FAILURES = 3;

/** Le débit que la réserve s'autorise pour un film de ce débit moyen, en bits par seconde. */
export function reserveSpeedBps(filmBps: number | null): number {
  const cap = SPEED_CAP_MBPS * 1e6;
  return filmBps !== null && Number.isFinite(filmBps) && filmBps > 0 ? Math.min(cap, SPEED_FACTOR * filmBps) : cap;
}

/**
 * La mémoire que la réserve peut prendre, en octets, en plus du tampon du navigateur et du cache de la
 * source (64 Mio).
 *
 * Safari ne dit pas combien de mémoire a l'appareil, et tue une page qui en prend trop — le seuil n'est
 * pas publié, il dépend du modèle : sur iPhone et iPad, une valeur prudente pour tous. Ailleurs,
 * `navigator.deviceMemory` (Chromium, arrondi à une puissance de deux) choisit le palier.
 */
export function reserveBudgetBytes(userAgent: string, hints: { maxTouchPoints?: number; deviceMemory?: number } = {}): number {
  const MB = 1e6;
  if (sourceBufferQuota(userAgent, hints)?.engine === "WebKit mobile") return 150 * MB;
  const memory = hints.deviceMemory;
  if (memory === undefined) return 300 * MB;
  if (memory <= 2) return 100 * MB;
  if (memory <= 4) return 200 * MB;
  return 500 * MB;
}

export interface ReserveContext {
  source: HttpByteSource;
  file: MatroskaFile;
  video: HTMLVideoElement;
  /** L'avance du tampon du navigateur, en secondes. */
  lead: () => number;
  /** Le décalage de présentation du remultiplexeur : l'horloge de l'élément moins celle du fichier. */
  delay: () => number;
}

/** Une ligne `reserve` du journal lecteur. */
export type ReserveReport = (fields: Record<string, string | number | boolean>) => void;

export interface ReserveFacts {
  /** Mio téléchargés par la réserve. */
  netChunks: number;
  /** Mio en réserve devant la tête, maintenant. */
  aheadChunks: number;
  /** Ce qu'elle peut garder, au plus. */
  allowedChunks: number;
  /** Ce que le lecteur a lu depuis la réserve, depuis l'appareil, et depuis le réseau — en Mo. */
  reserveMB: number;
  deviceMB: number;
  networkMB: number;
}

/** Ce que la réserve attend de son environnement — remplaçable dans les tests. */
export interface ReserveDeps {
  fetch: typeof fetch;
  now: () => number;
  hidden: () => boolean;
  budgetBytes: () => number;
}

const browserDeps: ReserveDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  budgetBytes: () => {
    try {
      const nav = navigator as Navigator & { deviceMemory?: number };
      return reserveBudgetBytes(nav.userAgent, { maxTouchPoints: nav.maxTouchPoints, deviceMemory: nav.deviceMemory });
    } catch {
      return 150e6;
    }
  },
};

export class MemoryReserve {
  private stopped = false;
  private readonly inflight = new Set<number>();
  private readonly controllers = new Set<AbortController>();
  private readonly fetches = new Set<Promise<void>>();
  private readonly allowed: number;
  private readonly speedBps: number;
  private nextFetchAt = 0;
  private failures = 0;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private netChunks = 0;
  /** Vidée en arrière-plan : combien de fois, combien de Mo. */
  private emptied = 0;
  private emptiedChunks = 0;
  private idle = "démarrage";
  private readonly startedAt: number;
  private lastReport: number;
  private windowBytes = 0;
  private windowBusyMs = 0;
  /** La position au dernier tour — l'élément est vidé quand l'arrêt écrit sa ligne. */
  private lastSeconds: number | null = null;

  private constructor(
    private readonly ctx: ReserveContext,
    private readonly report: ReserveReport,
    private readonly deps: ReserveDeps
  ) {
    this.allowed = Math.max(0, Math.floor(deps.budgetBytes() / CHUNK_SIZE));
    const duration = ctx.file.durationSeconds;
    this.speedBps = reserveSpeedBps(duration && duration > 0 ? (ctx.source.size * 8) / duration : null);
    this.startedAt = deps.now();
    this.lastReport = this.startedAt;
  }

  static start(ctx: ReserveContext, report: ReserveReport = () => {}, deps: ReserveDeps = browserDeps): MemoryReserve {
    const reserve = new MemoryReserve(ctx, report, deps);
    trace(`réserve en mémoire : jusqu'à ${reserve.allowed} Mo, ${Math.round(reserve.speedBps / 1e5) / 10} Mb/s au plus`);
    reserve.emit("départ", { allowedMB: reserve.allowed, speedMbps: Math.round(reserve.speedBps / 1e5) / 10 });
    reserve.timer = setInterval(() => reserve.tick(), TICK_MS);
    return reserve;
  }

  private seconds(): number {
    if (this.stopped && this.lastSeconds !== null) return this.lastSeconds;
    return Math.max(0, this.ctx.video.currentTime - this.ctx.delay());
  }

  private chunkAt(seconds: number): number {
    const video = this.ctx.file.tracks.find((track) => track.type === "video");
    const offset = clusterOffsetForTime(this.ctx.file, seconds * 1e6, video?.number) ?? this.ctx.file.firstClusterOffset ?? 0;
    return Math.floor(offset / CHUNK_SIZE);
  }

  private lastChunk(): number {
    return Math.floor((this.ctx.source.size - 1) / CHUNK_SIZE);
  }

  private expected(index: number): number {
    return Math.max(0, Math.min(CHUNK_SIZE, this.ctx.source.size - index * CHUNK_SIZE));
  }

  /** Pourquoi le lien n'est pas libre pour la réserve, ou null s'il l'est. */
  private blocked(): string | null {
    const { source, video } = this.ctx;
    if (this.stopped) return "arrêtée";
    if (video.seeking || source.seekFocused) return "saut";
    if (source.readsWaiting > 0) return "le lecteur attend un octet";
    if (this.deps.now() < this.pausedUntil) return "pause après un échec réseau";
    if (this.ctx.lead() < MIN_LEAD_SECONDS) return `avance du navigateur sous ${MIN_LEAD_SECONDS} s`;
    return null;
  }

  /** Ce qui est en mémoire d'un seul tenant devant la tête : en Mo de réserve, et en secondes de film. */
  private aheadSpan(): { chunks: number; seconds: number } {
    try {
      const now = this.seconds();
      const coverage = coverageFrom(this.ctx.file, now, (index) => this.ctx.source.hasInMemory(index));
      const reserved = this.ctx.source.reserveIndices.length;
      return { chunks: reserved, seconds: coverage ? Math.max(0, coverage.coveredTo - now) : 0 };
    } catch {
      return { chunks: 0, seconds: 0 };
    }
  }

  private emit(event: string, fields: Record<string, string | number | boolean>): void {
    try {
      this.report({ event, ...fields });
    } catch {
      /* le journal ne vaut pas un lecteur */
    }
  }

  private tick(): void {
    try {
      if (this.stopped) return;
      // En arrière-plan, la mémoire est rendue : iOS tue d'abord les pages qui en tiennent.
      if (this.deps.hidden()) {
        this.empty();
        this.idle = "page cachée — réserve vidée";
      } else {
        this.lastSeconds = this.seconds();
        this.fill();
      }
      if (this.deps.now() - this.lastReport >= REPORT_EVERY_MS) this.point();
    } catch {
      /* un tour de moins */
    }
  }

  /** Rend la mémoire de la réserve et coupe ce qui est en route. */
  private empty(): void {
    const held = this.ctx.source.reserveIndices.length;
    for (const control of this.controllers) control.abort();
    if (held === 0) return;
    this.ctx.source.clearReserve();
    this.emptied += 1;
    this.emptiedChunks += held;
    trace(`réserve en mémoire vidée (page cachée) : ${held} Mo rendus`);
  }

  private fill(): void {
    const blocked = this.blocked();
    this.idle = blocked ?? "";
    if (blocked) return;
    const { source } = this.ctx;
    const head = this.chunkAt(this.seconds());
    const lastWanted = Math.min(this.lastChunk(), this.chunkAt(this.seconds() + MAX_AHEAD_SECONDS));
    // Ce que la tête a dépassé, et les îles laissées par un saut : rendu.
    for (const index of source.reserveIndices) {
      if (index < head || index > lastWanted) source.dropReserve(index);
    }
    const held = () => source.reserveIndices.length + this.inflight.size;
    if (held() >= this.allowed) {
      this.idle = "réserve pleine";
      return;
    }
    const from = Math.max(head, source.demandedChunk + PLAYER_READAHEAD_CHUNKS + 1);
    if (from > lastWanted) {
      this.idle = `${MAX_AHEAD_SECONDS / 60} min d'avance atteintes`;
      return;
    }
    for (let index = from; index <= lastWanted && this.controllers.size < PARALLEL; ) {
      if (held() >= this.allowed) break;
      if (this.deps.now() < this.nextFetchAt) {
        this.idle = `débit limité à ${Math.round(this.speedBps / 1e5) / 10} Mb/s`;
        break;
      }
      if (source.hasInMemory(index) || this.inflight.has(index)) {
        index += 1;
        continue;
      }
      let count = 0;
      while (
        count < RANGE_CHUNKS &&
        index + count <= lastWanted &&
        !source.hasInMemory(index + count) &&
        !this.inflight.has(index + count) &&
        held() + count < this.allowed
      ) {
        count += 1;
      }
      if (count === 0) break;
      const bytes = Math.min(count * CHUNK_SIZE, source.size - index * CHUNK_SIZE);
      this.nextFetchAt = Math.max(this.deps.now(), this.nextFetchAt) + ((bytes * 8) / this.speedBps) * 1000;
      this.fetchRange(index, count);
      index += count;
    }
  }

  private fetchRange(first: number, count: number): void {
    const run = this.fetchRangeNow(first, count);
    this.fetches.add(run);
    void run.finally(() => this.fetches.delete(run));
  }

  private async fetchRangeNow(first: number, count: number): Promise<void> {
    const control = new AbortController();
    this.controllers.add(control);
    for (let i = 0; i < count; i++) this.inflight.add(first + i);
    const size = this.ctx.source.size;
    const start = first * CHUNK_SIZE;
    const end = Math.min((first + count) * CHUNK_SIZE, size) - 1;
    try {
      const sentAt = performance.now();
      const res = await this.deps.fetch(this.ctx.source.streamUrl, { headers: { Range: `bytes=${start}-${end}` }, signal: control.signal });
      const headersAt = performance.now();
      if (res.status === 401 && res.headers.get(SESSION_EXPIRED_HEADER) === "1") {
        this.stop("session terminée");
        return;
      }
      const total = Number(res.headers.get("Content-Range")?.split("/")[1]);
      if (res.status !== 206 || total !== size) throw new Error(`réponse ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength !== end - start + 1) throw new Error("longueur inattendue");
      const endAt = performance.now();
      diagRequest(sentAt, headersAt, endAt, bytes.byteLength, null);
      this.windowBytes += bytes.byteLength;
      this.windowBusyMs += endAt - sentAt;
      this.failures = 0;
      // Arrêtée ou cachée entre-temps : rien n'est gardé.
      if (this.stopped || control.signal.aborted || this.deps.hidden()) return;
      for (let i = 0; i < count; i++) {
        const index = first + i;
        const from = i * CHUNK_SIZE;
        // Une copie de 1 Mio, pas une vue : une vue garde en vie toute la plage de 8 Mio tant qu'un
        // seul de ses morceaux reste dans le cache du lecteur — jusqu'à 512 Mio pour 64 morceaux.
        if (this.ctx.source.offerReserve(index, bytes.slice(from, from + this.expected(index)))) this.netChunks += 1;
      }
    } catch (error) {
      if (this.stopped || control.signal.aborted) return;
      this.failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.pausedUntil = this.deps.now() + 5000 * this.failures;
      trace(`réserve : plage ${first}–${first + count - 1} Mo refusée (${message}), échec ${this.failures}/${MAX_FAILURES}`);
      this.emit("erreur", { chunk: first, count, message: message.slice(0, 200), failures: this.failures });
      if (this.failures >= MAX_FAILURES) this.stop(`réseau : ${message}`);
    } finally {
      for (let i = 0; i < count; i++) this.inflight.delete(first + i);
      this.controllers.delete(control);
    }
  }

  /** Le résumé, toutes les `REPORT_EVERY_MS` : au journal et dans la trace. */
  private point(): void {
    this.lastReport = this.deps.now();
    const ahead = this.aheadSpan();
    const facts = this.facts();
    const fetchMbps = this.windowBusyMs > 0 ? Math.round(((this.windowBytes * 8) / (this.windowBusyMs / 1000) / 1e6) * 10) / 10 : 0;
    const windowMB = Math.round(this.windowBytes / 1e5) / 10;
    this.windowBytes = 0;
    this.windowBusyMs = 0;
    trace(
      `réserve : ${ahead.chunks} Mo en mémoire, ${ahead.seconds.toFixed(0)} s d'avance — +${windowMB} Mo réseau` +
        (fetchMbps > 0 ? ` à ${fetchMbps} Mb/s` : "") +
        `, lecteur : ${facts.reserveMB} Mo lus de la réserve, ${facts.networkMB} du réseau` +
        (this.idle ? ` — en attente : ${this.idle}` : "")
    );
    this.emit("point", {
      position: Math.round(this.seconds() * 10) / 10,
      aheadMB: ahead.chunks,
      aheadS: Math.round(ahead.seconds),
      allowedMB: this.allowed,
      leadS: Math.round(this.ctx.lead() * 10) / 10,
      windowMB,
      fetchMbps,
      netMB: facts.netChunks,
      reserveMB: facts.reserveMB,
      deviceMB: facts.deviceMB,
      networkMB: facts.networkMB,
      emptiedMB: this.emptiedChunks,
      ...(this.idle ? { idle: this.idle } : {}),
    });
    diagReserve(facts);
  }

  facts(): ReserveFacts {
    const { source } = this.ctx;
    const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;
    return {
      netChunks: this.netChunks,
      aheadChunks: source.reserveIndices.length,
      allowedChunks: this.allowed,
      reserveMB: mb(source.reserveBytes),
      deviceMB: mb(source.deviceBytes),
      networkMB: mb(source.networkBytes),
    };
  }

  /** Pour les tests : un tour de boucle, puis l'attente des requêtes qu'il a lancées. */
  async settleForTests(): Promise<void> {
    this.tick();
    await Promise.all([...this.fetches]);
  }

  /** Arrête la réserve et rend sa mémoire. Sûr à appeler deux fois. Ne lève jamais. */
  stop(why = "fin de lecture"): ReserveFacts {
    if (this.stopped) return this.facts();
    const ahead = this.aheadSpan();
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const control of this.controllers) control.abort();
    const final = this.facts();
    try {
      this.ctx.source.clearReserve();
    } catch {
      /* rien */
    }
    diagReserve(final);
    trace(
      `réserve en mémoire arrêtée (${why}) : ${final.netChunks} Mo téléchargés, ${ahead.chunks} en réserve (${ahead.seconds.toFixed(0)} s) ; ` +
        `le lecteur a lu ${final.reserveMB} Mo de la réserve, ${final.deviceMB} de l'appareil, ${final.networkMB} du réseau`
    );
    this.emit("arrêt", {
      why,
      durationS: Math.round((this.deps.now() - this.startedAt) / 1000),
      aheadMB: ahead.chunks,
      aheadS: Math.round(ahead.seconds),
      netMB: final.netChunks,
      reserveMB: final.reserveMB,
      deviceMB: final.deviceMB,
      networkMB: final.networkMB,
      emptied: this.emptied,
      emptiedMB: this.emptiedChunks,
    });
    return final;
  }
}
