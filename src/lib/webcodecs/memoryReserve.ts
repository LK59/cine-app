import { CHUNK_SIZE, type HttpByteSource } from "./byteSource";
import { sourceBufferQuota } from "./bufferBudget";
import { clusterOffsetForTime, type MatroskaFile } from "./matroska";
import { diagReserve } from "./playbackDiagnosis";
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
 *    attend un octet, ni pendant un saut ni dans les `SEEK_SETTLE_MS` qui le suivent — ce qui était
 *    en route est coupé ;
 *  - la page cachée : la réserve est *vidée* — iOS tue d'abord, en arrière-plan, les pages qui
 *    tiennent de la mémoire ;
 *  - rien dans la zone de la lecture en avance du lecteur ; au plus `MAX_AHEAD_SECONDS` de film
 *    devant la tête ;
 *  - rien avant `START_AFTER_WATCHED_SECONDS` de lecture réelle : un quart des séances durent moins
 *    d'une minute (vérifier un épisode, se tromper de titre), et les 30 s du navigateur suffisent à la
 *    première ;
 *  - `SPEED_CAP_MBPS` au plus — seule la réserve est bridée, jamais la lecture.
 *
 * **Par rafales** (28/09/2026) : une radio reste éveillée plusieurs secondes après chaque transfert
 * (la « traîne », ~10 s en 4G) ; ce qui coûte, c'est le nombre de réveils, pas le volume. La réserve
 * se remplit donc d'un coup jusqu'à sa capacité, puis se tait jusqu'à redescendre à
 * `REFILL_BELOW` de celle-ci, et recommence — au lieu de compléter 8 Mio par 8 Mio dès qu'elle
 * baisse. Même volume, même plafond, une radio qui dort l'essentiel du temps à débit modéré. Le
 * facteur « quatre fois le débit du film » qui bornait la vitesse est retiré avec : une rafale
 * courte coûte moins qu'une rafale lente.
 */

/** L'avance du navigateur sous laquelle le lien reste tout entier au lecteur. */
export const MIN_LEAD_SECONDS = 10;
/** Requêtes à la fois, au plus. */
export const PARALLEL = 2;
/** Mio par requête, au plus — plus grand que ceux du lecteur, pour remplir un lien rapide malgré l'aller-retour. */
export const RANGE_CHUNKS = 8;
/** Jamais plus que cela de film devant la tête. */
export const MAX_AHEAD_SECONDS = 300;
/** La réserve ne télécharge pas plus vite que ce plafond, en Mb/s. */
export const SPEED_CAP_MBPS = 50;
/** Rien avant ce temps de lecture réelle dans la séance. */
export const START_AFTER_WATCHED_SECONDS = 60;
/** Une rafale part quand la réserve redescend à cette part de sa capacité. */
export const REFILL_BELOW = 0.5;
/**
 * Après un saut, le calme exigé avant une rafale (28/09/2026, demandé par l'administrateur) : des
 * sauts rapprochés — chercher une scène à coups de ±10 s — relançaient une rafale entre chacun, pour
 * une position quittée la seconde d'après. Chaque saut remet le compte à zéro.
 */
export const SEEK_SETTLE_MS = 10_000;
/**
 * Une plage qui n'a pas abouti en ce temps est coupée et comptée comme un échec. Sans échéance, une
 * connexion morte sans erreur (réseau mobile qui change d'antenne) gardait sa place parmi les
 * `PARALLEL` pour toute la séance : plus une seule rafale, sans une ligne au journal.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Le plus long repos après des échecs d'affilée — il double à chaque échec à partir de 5 s. */
const MAX_BACKOFF_MS = 60_000;
/** La lecture en avance du lecteur (`PREFETCH_CHUNKS` dans byteSource.ts) : la réserve commence au-delà. */
const PLAYER_READAHEAD_CHUNKS = 6;
const TICK_MS = 1000;
/** Tous les combien une ligne `point` résume la réserve, au journal et dans la trace. */
const REPORT_EVERY_MS = 30_000;

/** Le débit que la réserve s'autorise, en bits par seconde. */
export function reserveSpeedBps(): number {
  return SPEED_CAP_MBPS * 1e6;
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
  /**
   * Le temps réellement regardé dans la séance, en secondes — celui de l'hôte (`WatchedClock`), qui
   * survit aux reconstructions du lecteur. Absent : la réserve part sans attendre.
   */
  watched?: () => number;
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
  /** Prévient dès que la page passe en arrière-plan ; rend de quoi ne plus écouter. Optionnel. */
  onHidden?: (listener: () => void) => () => void;
  /** L'échéance d'une plage — `REQUEST_TIMEOUT_MS` hors des tests. */
  requestTimeoutMs?: number;
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
  onHidden: (listener) => {
    if (typeof document === "undefined") return () => {};
    const onChange = () => {
      if (document.visibilityState === "hidden") listener();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
};

export class MemoryReserve {
  private stopped = false;
  private readonly controllers = new Set<AbortController>();
  private readonly fetches = new Set<Promise<void>>();
  private readonly allowed: number;
  private readonly speedBps: number;
  private nextFetchAt = 0;
  /** En rafale (on remplit) ou au repos (la radio dort) — voir `REFILL_BELOW`. */
  private refilling = true;
  /** Rafales lancées, et si celle en cours a déjà été comptée (à sa première requête). */
  private bursts = 0;
  private burstCounted = false;
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
  /** Quand ce tour-là a lu la position — pour reconnaître un saut trop bref pour qu'un tour voie `seeking`. */
  private lastTickAt: number | null = null;
  /** Le dernier saut vu, pour `SEEK_SETTLE_MS`. */
  private lastSeekAt = -Infinity;
  /** Le tour précédent attendait-il déjà une lecture du lecteur ? — voir `fill`. */
  private waitedLastTick = false;
  private unlistenHidden: () => void = () => {};

  private constructor(
    private readonly ctx: ReserveContext,
    private readonly report: ReserveReport,
    private readonly deps: ReserveDeps
  ) {
    this.allowed = Math.max(0, Math.floor(deps.budgetBytes() / CHUNK_SIZE));
    this.speedBps = reserveSpeedBps();
    this.startedAt = deps.now();
    this.lastReport = this.startedAt;
  }

  static start(ctx: ReserveContext, report: ReserveReport = () => {}, deps: ReserveDeps = browserDeps): MemoryReserve {
    const reserve = new MemoryReserve(ctx, report, deps);
    trace(`réserve en mémoire : jusqu'à ${reserve.allowed} Mo, ${Math.round(reserve.speedBps / 1e5) / 10} Mb/s au plus`);
    reserve.emit("départ", { allowedMB: reserve.allowed, speedMbps: Math.round(reserve.speedBps / 1e5) / 10 });
    reserve.timer = setInterval(() => reserve.tick(), TICK_MS);
    // Rendue dès que la page est cachée, sans attendre le tour suivant : iOS suspend les minuteries
    // d'une page en arrière-plan, et ce tour-là pouvait ne jamais venir — la mémoire restait tenue
    // par une page que le système choisit alors d'abord de tuer.
    try {
      reserve.unlistenHidden = deps.onHidden?.(() => {
        if (reserve.stopped) return;
        reserve.empty();
        reserve.idle = "page cachée — réserve vidée";
      }) ?? (() => {});
    } catch {
      /* le tour suivant le fera */
    }
    return reserve;
  }

  /**
   * Les morceaux que la réserve a en route, tenus par la source : sa lecture en avance ne relance pas
   * au même instant la requête d'un morceau déjà demandé ici (`HttpByteSource.prefetchAfter`).
   */
  private get inflight(): Set<number> {
    return this.ctx.source.reserveInflight;
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
    if (video.seeking || source.seekFocused) {
      this.lastSeekAt = this.deps.now();
      return "saut";
    }
    if (this.deps.now() - this.lastSeekAt < SEEK_SETTLE_MS) return `saut récent — ${SEEK_SETTLE_MS / 1000} s de calme d'abord`;
    if (source.readsWaiting > 0) return "le lecteur attend un octet";
    if (this.deps.now() < this.pausedUntil) return "pause après un échec réseau";
    const watched = this.ctx.watched?.();
    if (watched !== undefined && watched < START_AFTER_WATCHED_SECONDS) return `${START_AFTER_WATCHED_SECONDS} s de lecture d'abord`;
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
        this.noticeJump();
        this.fill();
      }
      if (this.deps.now() - this.lastReport >= REPORT_EVERY_MS) this.point();
      // Chaque tour, pas seulement toutes les trente secondes : la ligne `stop` et un `stall` lisent
      // ces chiffres, et ils avaient jusqu'à trente secondes de retard (chasse aux défauts du 28/09).
      diagReserve(this.facts());
    } catch {
      /* un tour de moins */
    }
  }

  /**
   * Un saut que les tours n'ont pas vu `seeking` — il a duré moins d'une seconde — se lit dans la
   * position : elle a reculé, ou avancé plus que le temps écoulé ne le permet (vitesse ×2 comprise).
   */
  private noticeJump(): void {
    const now = this.deps.now();
    const seconds = this.seconds();
    if (this.lastSeconds !== null && this.lastTickAt !== null) {
      const moved = seconds - this.lastSeconds;
      const elapsed = Math.max(0, now - this.lastTickAt) / 1000;
      if (moved < -3 || moved > elapsed * 2 + 3) this.lastSeekAt = now;
    }
    this.lastSeconds = seconds;
    this.lastTickAt = now;
  }

  /** Coupe ce qui est en route — le saut ou le lecteur en ont besoin, pas la réserve. */
  private abortInflight(): void {
    if (this.controllers.size === 0) return;
    for (const control of this.controllers) control.abort();
    // Le rythme avait compté ces octets comme partis : ils ne le sont pas.
    this.nextFetchAt = this.deps.now();
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

  /** Le dernier morceau voulu : cinq minutes devant la tête, ou la fin du fichier s'il est plus près. */
  private lastWanted(seconds: number): number {
    const until = seconds + MAX_AHEAD_SECONDS;
    const duration = this.ctx.file.durationSeconds;
    // L'index donne le *début* du groupe qui contient l'instant : près de la fin, le dernier groupe
    // du film n'était jamais pris (chasse aux défauts du 28/09).
    const lastCue = this.ctx.file.cues.reduce((latest, cue) => Math.max(latest, cue.timeUs), 0) / 1e6;
    if ((duration !== null && until >= duration) || until >= lastCue) return this.lastChunk();
    return Math.min(this.lastChunk(), this.chunkAt(until));
  }

  private fill(): void {
    const { source } = this.ctx;
    const seconds = this.seconds();
    const head = this.chunkAt(seconds);
    const lastWanted = this.lastWanted(seconds);
    // Ce que la tête a dépassé, et les îles laissées par un saut : rendu — même quand le lien n'est
    // pas libre, rendre de la mémoire ne coûte rien au lecteur.
    for (const index of source.reserveIndices) {
      if (index < head || index > lastWanted) source.dropReserve(index);
    }
    const blocked = this.blocked();
    this.idle = blocked ?? "";
    // Un saut, ou une lecture qui attend encore au second tour : ce qui est en route est coupé. Pour
    // un saut, la plage vise l'ancienne position ; pour une lecture, chaque octet de la réserve est
    // un octet de moins pour elle. Une attente d'un seul tour est l'ordinaire d'une lecture en
    // avance — couper là jetterait des plages à moitié reçues pour rien.
    const waiting = source.readsWaiting > 0;
    if (blocked && (this.deps.now() - this.lastSeekAt < SEEK_SETTLE_MS || (waiting && this.waitedLastTick))) this.abortInflight();
    this.waitedLastTick = waiting;
    if (blocked) return;
    const held = () => source.reserveIndices.length + this.inflight.size;
    // La capacité : la part de mémoire, ou les cinq minutes devant la tête si elles tiennent en moins.
    const capacity = Math.min(this.allowed, Math.max(0, lastWanted - head + 1));
    if (!this.refilling) {
      if (held() > capacity * REFILL_BELOW) {
        this.idle = "au repos — la radio dort";
        return;
      }
      this.refilling = true;
    }
    const from = Math.max(head, source.demandedChunk + PLAYER_READAHEAD_CHUNKS + 1);
    const full = () => {
      this.refilling = false;
      this.burstCounted = false;
      this.idle =
        held() >= this.allowed ? "réserve pleine" : lastWanted === this.lastChunk() ? "fin du fichier atteinte" : `${MAX_AHEAD_SECONDS / 60} min d'avance atteintes`;
    };
    if (held() >= this.allowed || from > lastWanted) {
      if (this.inflight.size === 0) full();
      return;
    }
    for (let index = from; index <= lastWanted && this.controllers.size < PARALLEL; ) {
      if (held() >= this.allowed) break;
      if (this.deps.now() < this.nextFetchAt) {
        this.idle = `débit limité à ${Math.round(this.speedBps / 1e5) / 10} Mb/s`;
        break;
      }
      // Déjà là, ou déjà demandé — par la réserve, ou par le lecteur lui-même.
      const taken = (at: number) => source.hasInMemory(at) || this.inflight.has(at) || source.isFetching(at);
      if (taken(index)) {
        index += 1;
        continue;
      }
      let count = 0;
      while (
        count < RANGE_CHUNKS &&
        index + count <= lastWanted &&
        !taken(index + count) &&
        held() + count < this.allowed
      ) {
        count += 1;
      }
      if (count === 0) break;
      const bytes = Math.min(count * CHUNK_SIZE, source.size - index * CHUNK_SIZE);
      this.nextFetchAt = Math.max(this.deps.now(), this.nextFetchAt) + ((bytes * 8) / this.speedBps) * 1000;
      if (!this.burstCounted) {
        this.burstCounted = true;
        this.bursts += 1;
      }
      this.fetchRange(index, count);
      index += count;
    }
    // Plus rien à prendre dans la fenêtre, et rien en route : la rafale est finie.
    if (this.inflight.size === 0 && this.controllers.size === 0) {
      let missing = false;
      for (let index = from; index <= lastWanted && !missing; index++) if (!source.hasInMemory(index)) missing = true;
      if (!missing || held() >= this.allowed) full();
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
    const inflight = this.inflight;
    for (let i = 0; i < count; i++) inflight.add(first + i);
    const size = this.ctx.source.size;
    const start = first * CHUNK_SIZE;
    const end = Math.min((first + count) * CHUNK_SIZE, size) - 1;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      control.abort();
    }, this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const sentAt = performance.now();
      const res = await this.deps.fetch(this.ctx.source.streamUrl, { headers: { Range: `bytes=${start}-${end}` }, signal: control.signal });
      if (res.status === 401 && res.headers.get(SESSION_EXPIRED_HEADER) === "1") {
        this.stop("session terminée");
        return;
      }
      const total = Number(res.headers.get("Content-Range")?.split("/")[1]);
      if (res.status !== 206 || total !== size) throw new Error(`réponse ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength !== end - start + 1) throw new Error("longueur inattendue");
      // Pas dans les mesures réseau du lecteur (`diagRequest`) : une plage de 8 Mio bridée n'y dit rien
      // de ce que le lecteur a attendu, et y faussait la requête la plus lente et les premiers octets.
      const endAt = performance.now();
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
      if (this.stopped || (control.signal.aborted && !timedOut)) return;
      this.failures += 1;
      const message = timedOut ? `sans réponse en ${Math.round((this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)} s` : error instanceof Error ? error.message : String(error);
      // Un repos qui double, jusqu'à une minute — plus d'arrêt pour la séance : trois échecs dans un
      // tunnel coupaient la réserve pour tout le reste du film, réseau revenu ou pas.
      const backoff = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** (this.failures - 1));
      this.pausedUntil = this.deps.now() + backoff;
      trace(`réserve : plage ${first}–${first + count - 1} Mo refusée (${message}), échec ${this.failures} — reprise dans ${backoff / 1000} s`);
      this.emit("erreur", { chunk: first, count, message: message.slice(0, 200), failures: this.failures, backoffS: backoff / 1000 });
    } finally {
      clearTimeout(deadline);
      for (let i = 0; i < count; i++) inflight.delete(first + i);
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
      phase: this.refilling ? "rafale" : "repos",
      bursts: this.bursts,
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

  /**
   * Arrête la réserve. Sûr à appeler deux fois. Ne lève jamais.
   *
   * @param keep laisser ses morceaux à la source : c'est la fin d'un pipeline, et la source qui se
   *   ferme les passe au relais (`HttpByteSource.close`) — une reconstruction (changement de piste,
   *   reprise après une erreur) retrouve alors sa réserve au lieu de retélécharger jusqu'à 150 Mo.
   *   Faux : sa mémoire est rendue tout de suite.
   */
  stop(why = "fin de lecture", keep = false): ReserveFacts {
    if (this.stopped) return this.facts();
    const ahead = this.aheadSpan();
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try {
      this.unlistenHidden();
    } catch {
      /* rien */
    }
    for (const control of this.controllers) control.abort();
    const final = this.facts();
    try {
      if (!keep) this.ctx.source.clearReserve();
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
      bursts: this.bursts,
    });
    return final;
  }
}
