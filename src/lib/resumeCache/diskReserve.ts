import { CHUNK_SIZE, type DiskChunks, type HttpByteSource } from "@/lib/webcodecs/byteSource";
import { clusterOffsetForTime, type MatroskaFile } from "@/lib/webcodecs/matroska";
import { diagRequest, diagReserve } from "@/lib/webcodecs/playbackDiagnosis";
import { SESSION_EXPIRED_HEADER } from "@/lib/sessionExpired";
import { trace } from "@/lib/webcodecs/trace";
import { activeTitles, deviceBudget, NORMAL_BUDGET, type StorageBudget } from "./budget";
import { coverageFrom } from "./coverage";
import { diskChunksFor, sameFile, type FileIdentity } from "./diskChunks";
import { mergeResumeEntry, readResumeIndex, readResumeManifest, writeResumeChunk, type ResumeFile, type ResumeManifest } from "./store";

/**
 * Le tampon d'avance sur l'appareil : pendant une lecture, prendre de l'avance dans l'OPFS quand le
 * lien le permet (28/09/2026).
 *
 * Le tampon du navigateur est plafonné — 105 Mo sur iPhone, soit ~31 s d'un 4K (`bufferBudget.ts`).
 * Un lien qui tombe plus longtemps que ça coupe l'image, même s'il allait deux fois plus vite que le
 * film la minute d'avant. Ce module met chaque moment de débit à profit : quand le lecteur a ce qu'il
 * lui faut, il télécharge plus loin et l'écrit sur l'appareil, où `HttpByteSource` le lit avant le
 * réseau. Dans un train, 200 Mb/s pendant trente secondes remplissent la réserve ; le tunnel qui suit
 * se joue depuis le disque.
 *
 * Ce qu'il s'interdit — chacune de ces règles protège le lecteur, qui passe toujours avant :
 *  - rien tant que le tampon du navigateur n'a pas `MIN_LEAD_SECONDS` d'avance, ni pendant qu'une
 *    lecture attend un octet (`readsWaiting`), ni pendant un saut, ni la page cachée ;
 *  - rien dans la zone que la lecture en avance du lecteur couvre déjà : il commence au-delà ;
 *  - jamais plus de `PARALLEL` requêtes à la fois, de `RANGE_CHUNKS` Mio chacune — des plages plus
 *    grandes que celles du lecteur, pour remplir un lien rapide malgré l'aller-retour vers le serveur ;
 *  - rien ne passe par la mémoire du lecteur (48 Mio, qu'il faut à la lecture) : écrit directement.
 *
 * Le budget (`budget.ts`) : la réserve commune, dont le titre en cours peut tout prendre sauf le
 * plancher des autres titres actifs — ceux-ci sont réduits, du moins récemment lu au plus récent, en
 * effaçant leur plus lointain, et seulement quand la place manque. Derrière la tête, `behindChunks`
 * sont gardés pour un retour en arrière, le reste est effacé à mesure.
 *
 * Tout passe par `mergeResumeEntry` : l'arrêt (`keepOnStop`) et une reconstruction du lecteur
 * écrivent dans le même manifeste sans rien défaire. Rien ici ne lève vers le lecteur : un échec
 * arrête le tampon, et la lecture continue par le réseau comme avant.
 */

/** L'avance du navigateur sous laquelle le lien reste tout entier au lecteur. */
export const MIN_LEAD_SECONDS = 10;
/** Requêtes à la fois, au plus. */
export const PARALLEL = 3;
/** Mio par requête, au plus. */
export const RANGE_CHUNKS = 8;
/** La lecture en avance du lecteur (`PREFETCH_CHUNKS` dans byteSource.ts) : il commence au-delà. */
const PLAYER_READAHEAD_CHUNKS = 6;
/** Le pas de la boucle. */
const TICK_MS = 1000;
/** Tous les combien le manifeste est mis à jour, et ce qui est derrière la tête effacé. */
const PERSIST_EVERY_MS = 15_000;
/** Après ces échecs d'affilée, le tampon s'arrête pour la séance. */
const MAX_FAILURES = 3;

export interface ReserveContext {
  source: HttpByteSource;
  file: MatroskaFile;
  video: HTMLVideoElement;
  /** L'avance du tampon du navigateur, en secondes. */
  lead: () => number;
  /** Le décalage de présentation du remultiplexeur : l'horloge de l'élément moins celle du fichier. */
  delay: () => number;
}

/** Une ligne `reserve` du journal lecteur — voir `DiskReserve.report`. */
export type ReserveReport = (fields: Record<string, string | number | boolean>) => void;

/** Tous les combien une ligne `point` résume le tampon, au journal et dans la trace. */
const REPORT_EVERY_MS = 30_000;

export interface ReserveFacts {
  /** Mio écrits sur l'appareil depuis le réseau, par ce tampon. */
  netChunks: number;
  /** Mio écrits depuis la mémoire du lecteur, sans réseau. */
  memoryChunks: number;
  /** Mio sur l'appareil devant la tête, maintenant. */
  aheadChunks: number;
  /** Ce qu'il peut garder devant la tête, au plus. */
  allowedChunks: number;
  /** Ce que le lecteur a lu depuis l'appareil, et depuis le réseau, sur ce pipeline — en Mo. */
  deviceMB: number;
  networkMB: number;
}

/** Ce que le tampon attend de son environnement — remplaçable dans les tests. */
export interface ReserveDeps {
  fetch: typeof fetch;
  now: () => number;
  budget: () => Promise<StorageBudget>;
  hidden: () => boolean;
}

const browserDeps: ReserveDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  budget: deviceBudget,
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
};

export class DiskReserve {
  private stopped = false;
  private ready = false;
  private readonly onDisk = new Set<number>();
  /** Écrits ou effacés depuis la dernière mise à jour du manifeste. */
  private added = new Set<number>();
  private removed = new Set<number>();
  private readonly inflight = new Set<number>();
  private readonly controllers = new Set<AbortController>();
  private writing: Promise<unknown> = Promise.resolve();
  private layer: DiskChunks | null = null;
  private budget: StorageBudget = NORMAL_BUDGET;
  /** Le plus que ce titre peut garder devant la tête, les autres ramenés à leur plancher. */
  private allowed = 0;
  /** Ce que les autres titres actifs gardent vraiment, maintenant. */
  private othersReserve = 0;
  /** La mise à jour du manifeste en cours, s'il y en a une — l'arrêt l'attend. */
  private persisting: Promise<void> | null = null;
  /** La place en train d'être prise aux autres titres, s'il y en a une. */
  private room: Promise<void> | null = null;
  private failures = 0;
  private pausedUntil = 0;
  private lastPersist = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private netChunks = 0;
  private memoryChunks = 0;
  /** Effacés derrière la tête, et repris aux autres titres — cumulés. */
  private behindRemoved = 0;
  private borrowed = 0;
  /** Pourquoi le dernier tour n'a rien demandé — la ligne `point` le dit. */
  private idle = "démarrage";
  private lastReport = 0;
  /** Le réseau du tampon depuis la dernière ligne `point`. */
  private windowBytes = 0;
  private windowBusyMs = 0;
  private startedAt = 0;
  /** Les morceaux de l'en-tête (début du fichier) : jamais effacés comme « derrière la tête ». */
  private readonly protectedBelow: number;

  private constructor(
    private readonly account: string,
    private readonly file: ResumeFile,
    private readonly ctx: ReserveContext,
    private readonly deps: ReserveDeps,
    private readonly report: ReserveReport
  ) {
    this.protectedBelow = Math.floor((ctx.file.firstClusterOffset ?? ctx.file.segmentDataStart) / CHUNK_SIZE);
  }

  /** Démarre le tampon d'un lecteur. Null quand il n'y a rien de sûr à écrire (fichier sans version). */
  static start(account: string, identity: FileIdentity, ctx: ReserveContext, report: ReserveReport = () => {}, deps: ReserveDeps = browserDeps): DiskReserve | null {
    if (!identity.fileVersion || identity.size === null || identity.size !== ctx.source.size) return null;
    const file: ResumeFile = {
      itemId: identity.itemId,
      streamUrl: identity.streamUrl,
      size: identity.size,
      fileVersion: identity.fileVersion,
      lastModified: ctx.source.lastModified,
    };
    const reserve = new DiskReserve(account, file, ctx, deps, report);
    void reserve.init();
    return reserve;
  }

  private async init(): Promise<void> {
    try {
      this.budget = await this.deps.budget();
      const manifest = await readResumeManifest(this.account, this.file.itemId);
      const same = manifest && sameFile(manifest, this.file) ? manifest : null;
      for (const index of same?.chunks ?? []) this.onDisk.add(index);
      // La couche que lit le lecteur : celle de l'ouverture, ou une neuve posée maintenant.
      this.layer = this.ctx.source.diskLayer;
      if (!this.layer) {
        const empty: ResumeManifest = {
          v: 1,
          ...this.file,
          savedAt: this.deps.now(),
          startSeconds: -1,
          coveredFrom: -1,
          coveredTo: -1,
          chunks: [...this.onDisk],
          bytes: 0,
          partial: false,
        };
        this.layer = diskChunksFor(this.account, empty);
        this.ctx.source.attachDisk(this.layer);
      }
      await this.reckon();
      if (this.stopped) return;
      this.ready = true;
      this.startedAt = this.deps.now();
      this.lastReport = this.startedAt;
      const ahead = this.aheadSpan();
      trace(`réserve sur l'appareil : ${this.onDisk.size} Mo déjà là, dont ${ahead.chunks} devant la tête (${ahead.seconds.toFixed(0)} s), jusqu'à ${this.allowed} Mo (${this.budget.mode})`);
      this.emit("départ", {
        onDiskMB: this.onDisk.size,
        aheadMB: ahead.chunks,
        aheadS: Math.round(ahead.seconds),
        allowedMB: this.allowed,
        limitMB: this.limit(),
        othersMB: this.othersReserve,
        mode: this.budget.mode,
      });
      this.timer = setInterval(() => this.tick(), TICK_MS);
    } catch {
      this.stopped = true;
    }
  }

  /**
   * Ce que ce titre peut garder devant la tête : la réserve, moins ce que les autres titres actifs
   * gardent — ramené, s'il le faut, à leur plancher.
   */
  private async reckon(): Promise<void> {
    const index = await readResumeIndex(this.account);
    const now = this.deps.now();
    // Ce titre-ci est lu maintenant : il est actif, et le plus récent.
    const others = activeTitles({ ...index, [this.file.itemId]: { ...(index[this.file.itemId] ?? {}), playedAt: now } } as typeof index, now).filter(
      (itemId) => itemId !== this.file.itemId
    );
    const floors = others.reduce((sum, itemId) => sum + Math.min(index[itemId]?.reserveChunks ?? 0, this.budget.floorChunks), 0);
    this.othersReserve = others.reduce((sum, itemId) => sum + (index[itemId]?.reserveChunks ?? 0), 0);
    this.allowed = Math.max(0, this.budget.poolChunks - floors);
  }

  /** Ce que ce titre peut garder devant la tête sans rien prendre aux autres. */
  private limit(): number {
    return Math.min(this.allowed, Math.max(0, this.budget.poolChunks - this.othersReserve));
  }

  /**
   * La place pour `need` morceaux de plus : les autres titres actifs rendent ce qu'ils ont au-dessus de
   * leur plancher, le moins récemment lu d'abord, leur plus lointain d'abord. L'en-tête d'un titre et
   * ce qui n'a pas encore été mesuré (`headerChunks` absent) ne sont jamais touchés.
   */
  private async makeRoom(need: number): Promise<void> {
    const index = await readResumeIndex(this.account);
    const now = this.deps.now();
    const others = activeTitles(index, now)
      .filter((itemId) => itemId !== this.file.itemId)
      .reverse();
    let room = this.budget.poolChunks - this.aheadCount() - this.inflight.size - others.reduce((sum, itemId) => sum + (index[itemId]?.reserveChunks ?? 0), 0);
    for (const itemId of others) {
      if (room >= need || this.stopped) return;
      const manifest = await readResumeManifest(this.account, itemId);
      if (!manifest?.headerChunks) continue;
      const header = new Set(manifest.headerChunks);
      const reserve = manifest.chunks.filter((i) => !header.has(i)).sort((a, b) => b - a);
      const excess = reserve.length - this.budget.floorChunks;
      if (excess <= 0) continue;
      const drop = reserve.slice(0, Math.min(excess, need - room));
      const file = { itemId, streamUrl: manifest.streamUrl, size: manifest.size, fileVersion: manifest.fileVersion, lastModified: manifest.lastModified };
      // Sa couverture a changé : le prochain passage d'arrière-plan la remesure.
      if (await mergeResumeEntry(this.account, file, [], drop, { coveredTo: -1, coveredFrom: -1, startSeconds: -1 })) {
        room += drop.length;
        this.borrowed += drop.length;
        trace(`réserve sur l'appareil : ${drop.length} Mo repris à un autre titre (${itemId})`);
        this.emit("emprunt", { fromItem: itemId, borrowedMB: drop.length, theyKeepMB: reserve.length - drop.length });
      }
    }
  }

  /** Le morceau sous la tête de lecture. */
  private headChunk(): number {
    const seconds = Math.max(0, this.ctx.video.currentTime - this.ctx.delay());
    const video = this.ctx.file.tracks.find((track) => track.type === "video");
    const offset = clusterOffsetForTime(this.ctx.file, seconds * 1e6, video?.number) ?? this.ctx.file.firstClusterOffset ?? 0;
    return Math.floor(offset / CHUNK_SIZE);
  }

  private aheadCount(head = this.headChunk()): number {
    let n = 0;
    for (const index of this.onDisk) if (index >= head) n += 1;
    return n;
  }

  private lastChunk(): number {
    return Math.floor((this.file.size - 1) / CHUNK_SIZE);
  }

  private expected(index: number): number {
    return Math.max(0, Math.min(CHUNK_SIZE, this.file.size - index * CHUNK_SIZE));
  }

  /**
   * Pourquoi le lien n'est pas libre pour le tampon, ou null s'il l'est. Chaque condition protège le
   * lecteur ; la raison part dans la ligne `point`, pour qu'une réserve qui n'avance pas se lise.
   */
  private blocked(): string | null {
    const { source, video } = this.ctx;
    if (this.stopped || !this.ready) return "arrêtée";
    if (this.layer?.disabled) return "fichier changé";
    if (this.deps.hidden()) return "page cachée";
    if (video.seeking || source.seekFocused) return "saut";
    if (source.readsWaiting > 0) return "le lecteur attend un octet";
    if (this.deps.now() < this.pausedUntil) return "pause après un échec réseau";
    if (this.ctx.lead() < MIN_LEAD_SECONDS) return `avance du navigateur sous ${MIN_LEAD_SECONDS} s`;
    return null;
  }

  /**
   * Ce que l'appareil tient d'un seul tenant devant la tête : en Mo, et en secondes de film, lu dans
   * l'index (`coverageFrom`). Ne lève jamais.
   */
  private aheadSpan(): { chunks: number; seconds: number } {
    try {
      const now = Math.max(0, this.ctx.video.currentTime - this.ctx.delay());
      const has = (index: number) => this.onDisk.has(index) || this.ctx.source.memoryChunk(index) !== null;
      const coverage = coverageFrom(this.ctx.file, now, has);
      if (!coverage) return { chunks: 0, seconds: 0 };
      const head = this.headChunk();
      return { chunks: coverage.chunks.filter((index) => index >= head && this.onDisk.has(index)).length, seconds: Math.max(0, coverage.coveredTo - now) };
    } catch {
      return { chunks: 0, seconds: 0 };
    }
  }

  /** Une ligne `reserve` au journal lecteur. Ne lève jamais. */
  private emit(event: string, fields: Record<string, string | number | boolean>): void {
    try {
      this.report({ event, ...fields });
    } catch {
      /* le journal ne vaut pas un lecteur */
    }
  }

  /** Le résumé de la réserve, toutes les `REPORT_EVERY_MS` : au journal et dans la trace. */
  private point(): void {
    this.lastReport = this.deps.now();
    const ahead = this.aheadSpan();
    const facts = this.facts();
    const fetchMbps = this.windowBusyMs > 0 ? Math.round(((this.windowBytes * 8) / (this.windowBusyMs / 1000) / 1e6) * 10) / 10 : 0;
    const windowMB = Math.round(this.windowBytes / 1e5) / 10;
    this.windowBytes = 0;
    this.windowBusyMs = 0;
    const position = Math.round(this.ctx.video.currentTime * 10) / 10;
    trace(
      `réserve : ${ahead.chunks} Mo devant (${ahead.seconds.toFixed(0)} s) sur ${this.limit()} permis — +${windowMB} Mo réseau` +
        (fetchMbps > 0 ? ` à ${fetchMbps} Mb/s` : "") +
        `, lecteur : ${facts.deviceMB} Mo lus de l'appareil, ${facts.networkMB} du réseau` +
        (this.idle ? ` — en attente : ${this.idle}` : "")
    );
    this.emit("point", {
      position,
      aheadMB: ahead.chunks,
      aheadS: Math.round(ahead.seconds),
      limitMB: this.limit(),
      allowedMB: this.allowed,
      leadS: Math.round(this.ctx.lead() * 10) / 10,
      windowMB,
      fetchMbps,
      netMB: facts.netChunks,
      memMB: facts.memoryChunks,
      deviceMB: facts.deviceMB,
      networkMB: facts.networkMB,
      behindRemovedMB: this.behindRemoved,
      borrowedMB: this.borrowed,
      inflightMB: this.inflight.size,
      ...(this.idle ? { idle: this.idle } : {}),
    });
    diagReserve(facts);
  }

  private tick(): void {
    try {
      if (this.stopped || !this.ready) return;
      if (this.layer?.disabled) {
        void this.stop("le fichier a changé");
        return;
      }
      if (this.deps.now() - this.lastPersist >= PERSIST_EVERY_MS && !this.persisting) {
        this.persisting = this.persist().finally(() => {
          this.persisting = null;
        });
      }
      const blocked = this.blocked();
      this.idle = blocked ?? "";
      if (this.deps.now() - this.lastReport >= REPORT_EVERY_MS) this.point();
      if (blocked) return;
      const head = this.headChunk();
      // Ce que le lecteur tient déjà en mémoire devant la tête : écrit tel quel, sans réseau.
      let ahead = this.aheadCount(head);
      const limit = this.limit();
      // Des morceaux en route mais pas encore écrits : pas de nouvelle requête tant qu'il y en a
      // autant que les requêtes parallèles en portent — la mémoire reste bornée si le disque traîne.
      if (this.inflight.size >= PARALLEL * RANGE_CHUNKS) {
        this.idle = "écriture sur l'appareil en retard";
        return;
      }
      // La limite est atteinte, mais par des îles loin devant (un retour en arrière, un saut) alors
      // que la tête a un trou devant elle : le plus lointain part d'abord, pour que l'avance soit
      // d'un seul tenant là où elle sert.
      if (ahead + this.inflight.size >= limit) {
        this.dropFarthestIslands(head, RANGE_CHUNKS * PARALLEL);
        ahead = this.aheadCount(head);
      }
      // Au bout de ce qui est libre, mais pas de ce qui peut l'être : de la place est prise aux autres
      // titres actifs, une fois à la fois, et le prochain tour en profite.
      if (ahead + this.inflight.size + RANGE_CHUNKS > limit && limit < this.allowed && !this.room) {
        this.room = this.makeRoom(RANGE_CHUNKS * 2)
          .then(() => this.reckon())
          .catch(() => {})
          .finally(() => {
            this.room = null;
          });
      }
      if (ahead + this.inflight.size >= limit) this.idle = limit < this.allowed ? "limite : place prise aux autres titres" : "réserve pleine";
      for (let index = head; index <= this.lastChunk() && ahead + this.inflight.size < limit; index++) {
        if (this.onDisk.has(index) || this.inflight.has(index)) continue;
        const held = this.ctx.source.memoryChunk(index);
        if (!held) {
          if (index > this.ctx.source.demandedChunk + PLAYER_READAHEAD_CHUNKS) break;
          continue;
        }
        this.inflight.add(index);
        this.queueWrite(index, held, "mémoire");
      }
      // Puis le réseau, au-delà de la lecture en avance du lecteur.
      const from = Math.max(head, this.ctx.source.demandedChunk + PLAYER_READAHEAD_CHUNKS + 1);
      let fetching = this.controllers.size;
      for (let index = from; index <= this.lastChunk() && fetching < PARALLEL; ) {
        if (ahead + this.inflight.size >= limit) break;
        if (this.onDisk.has(index) || this.inflight.has(index)) {
          index += 1;
          continue;
        }
        let count = 0;
        while (count < RANGE_CHUNKS && index + count <= this.lastChunk() && !this.onDisk.has(index + count) && !this.inflight.has(index + count) && ahead + this.inflight.size + count < limit) {
          count += 1;
        }
        if (count === 0) break;
        void this.fetchRange(index, count);
        fetching += 1;
        index += count;
      }
    } catch {
      /* un tour de moins */
    }
  }

  /** Les requêtes en cours — pour `settle`. */
  private readonly fetches = new Set<Promise<void>>();

  /**
   * Pour les tests : un tour de boucle, puis l'attente des requêtes et des écritures qu'il a lancées.
   * La boucle réelle tourne sur un minuteur.
   */
  async settleForTests(): Promise<void> {
    while (!this.ready && !this.stopped) await new Promise((resolve) => setTimeout(resolve, 1));
    this.tick();
    await this.persisting;
    await this.room;
    await Promise.all([...this.fetches]);
    await this.writing;
  }

  private fetchRange(first: number, count: number): Promise<void> {
    const run = this.fetchRangeNow(first, count);
    this.fetches.add(run);
    void run.finally(() => this.fetches.delete(run));
    return run;
  }

  private async fetchRangeNow(first: number, count: number): Promise<void> {
    const control = new AbortController();
    this.controllers.add(control);
    for (let i = 0; i < count; i++) this.inflight.add(first + i);
    const start = first * CHUNK_SIZE;
    const end = Math.min((first + count) * CHUNK_SIZE, this.file.size) - 1;
    try {
      const sentAt = performance.now();
      const res = await this.deps.fetch(this.file.streamUrl, { headers: { Range: `bytes=${start}-${end}` }, signal: control.signal });
      const headersAt = performance.now();
      if (res.status === 401 && res.headers.get(SESSION_EXPIRED_HEADER) === "1") {
        void this.stop("session terminée");
        return;
      }
      const total = Number(res.headers.get("Content-Range")?.split("/")[1]);
      if (res.status !== 206 || total !== this.file.size) throw new Error(`réponse ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength !== end - start + 1) throw new Error("longueur inattendue");
      const endAt = performance.now();
      diagRequest(sentAt, headersAt, endAt, bytes.byteLength, null);
      this.windowBytes += bytes.byteLength;
      this.windowBusyMs += endAt - sentAt;
      this.failures = 0;
      // Arrivé après l'arrêt : le manifeste est déjà écrit, et ces morceaux n'y seraient pas.
      if (this.stopped) {
        for (let i = 0; i < count; i++) this.inflight.delete(first + i);
        return;
      }
      for (let i = 0; i < count; i++) {
        const index = first + i;
        const from = i * CHUNK_SIZE;
        this.queueWrite(index, bytes.subarray(from, from + this.expected(index)), "réseau");
      }
    } catch (error) {
      for (let i = 0; i < count; i++) this.inflight.delete(first + i);
      if (this.stopped || control.signal.aborted) return;
      this.failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      // Le réseau vacille : le lien au lecteur, et on réessaie plus tard.
      this.pausedUntil = this.deps.now() + 5000 * this.failures;
      trace(`réserve : plage ${first}–${first + count - 1} Mo refusée (${message}), échec ${this.failures}/${MAX_FAILURES}`);
      this.emit("erreur", { chunk: first, count, message: message.slice(0, 200), failures: this.failures });
      if (this.failures >= MAX_FAILURES) void this.stop(`réseau : ${message}`);
    } finally {
      this.controllers.delete(control);
    }
  }

  /** Une écriture de plus, à la suite des autres. */
  private queueWrite(index: number, bytes: Uint8Array, origin: "mémoire" | "réseau"): void {
    this.writing = this.writing
      .then(async () => {
        if (this.layer?.disabled || bytes.byteLength !== this.expected(index)) return;
        if (await writeResumeChunk(this.account, this.file.itemId, index, bytes)) {
          this.onDisk.add(index);
          this.added.add(index);
          this.removed.delete(index);
          this.layer?.add?.(index);
          if (origin === "réseau") this.netChunks += 1;
          else this.memoryChunks += 1;
        }
      })
      .catch(() => {})
      .finally(() => this.inflight.delete(index));
  }

  /**
   * Retire jusqu'à `count` morceaux au-delà du premier trou devant la tête — les plus lointains
   * d'abord. Rien s'il n'y a pas de trou avant la limite : l'avance est alors d'un seul tenant, et
   * pleine. Jamais l'en-tête (début du fichier) ni ses deux derniers morceaux (l'index y est rangé).
   * Effacés à la prochaine mise à jour du manifeste.
   */
  private dropFarthestIslands(head: number, count: number): void {
    // Là où commence la part du tampon : ce qui précède est la lecture en avance du lecteur, en
    // mémoire ou en route chez lui — pas un trou.
    let gap = Math.max(head, this.ctx.source.demandedChunk + PLAYER_READAHEAD_CHUNKS + 1);
    while (gap <= this.lastChunk() && (this.onDisk.has(gap) || this.inflight.has(gap) || this.ctx.source.memoryChunk(gap))) gap += 1;
    if (gap > this.lastChunk()) return;
    const islands = [...this.onDisk].filter((index) => index > gap && index < this.lastChunk() - 1).sort((a, b) => b - a);
    for (const index of islands.slice(0, count)) {
      this.onDisk.delete(index);
      this.layer?.forget?.(index);
      this.added.delete(index);
      this.removed.add(index);
    }
    if (islands.length > 0) trace(`réserve : ${Math.min(count, islands.length)} Mo lointains libérés pour combler le trou devant la tête (morceau ${gap})`);
  }

  /** Efface ce qui est loin derrière la tête, puis écrit le manifeste par différence. */
  private async persist(): Promise<void> {
    this.lastPersist = this.deps.now();
    try {
      const head = this.headChunk();
      for (const index of this.onDisk) {
        if (index >= head - this.budget.behindChunks || index <= this.protectedBelow) continue;
        this.onDisk.delete(index);
        this.layer?.forget?.(index);
        this.added.delete(index);
        this.removed.add(index);
        this.behindRemoved += 1;
      }
      const add = [...this.added];
      const remove = [...this.removed];
      this.added = new Set();
      this.removed = new Set();
      diagReserve(this.facts());
      if (add.length === 0 && remove.length === 0) return;
      const ok = await mergeResumeEntry(this.account, this.file, add, remove, {
        startSeconds: -1,
        coveredFrom: -1,
        coveredTo: -1,
        partial: false,
        playedAt: this.deps.now(),
      });
      if (!ok) {
        // Un autre fichier sous ce titre, ou plus de place : on s'arrête là, le lecteur continue.
        void this.stop("manifeste refusé");
        return;
      }
      await this.reckon();
    } catch {
      /* au prochain tour */
    }
  }

  facts(): ReserveFacts {
    let aheadChunks = 0;
    try {
      aheadChunks = this.aheadCount();
    } catch {
      /* rien */
    }
    const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;
    return {
      netChunks: this.netChunks,
      memoryChunks: this.memoryChunks,
      aheadChunks,
      allowedChunks: this.allowed,
      deviceMB: mb(this.ctx.source.deviceBytes),
      networkMB: mb(this.ctx.source.networkBytes),
    };
  }

  /**
   * Arrête le tampon : plus de requête, les écritures en cours finissent, le manifeste est mis à jour.
   * Sûr à appeler deux fois. Ne lève jamais.
   */
  async stop(why = "fin de lecture"): Promise<ReserveFacts> {
    const facts = this.facts();
    if (this.stopped) return facts;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const control of this.controllers) control.abort();
    try {
      await this.writing;
      await this.persisting;
      await this.room;
      await this.persist();
    } catch {
      /* rien */
    }
    const final = this.facts();
    const ahead = this.aheadSpan();
    diagReserve(final);
    trace(
      `réserve sur l'appareil arrêtée (${why}) : ${final.netChunks} Mo du réseau, ${final.memoryChunks} de la mémoire, ` +
        `${ahead.chunks} devant la tête (${ahead.seconds.toFixed(0)} s) ; le lecteur a lu ${final.deviceMB} Mo de l'appareil, ${final.networkMB} du réseau`
    );
    this.emit("arrêt", {
      why,
      durationS: Math.round((this.deps.now() - this.startedAt) / 1000),
      aheadMB: ahead.chunks,
      aheadS: Math.round(ahead.seconds),
      netMB: final.netChunks,
      memMB: final.memoryChunks,
      deviceMB: final.deviceMB,
      networkMB: final.networkMB,
      behindRemovedMB: this.behindRemoved,
      borrowedMB: this.borrowed,
    });
    return final;
  }
}
