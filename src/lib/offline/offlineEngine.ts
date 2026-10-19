import { fragmentIndexAt, normalizeFragment, parseInit, scanFragments, type Fmp4Fragment, type Fmp4Init } from "./fmp4";

/**
 * Le moteur du lecteur des téléchargements (19/10/2026) — un chemin à part, voulu tel par Louis :
 * rien ici n'est partagé avec le lecteur en ligne (`webcodecs/`, `ExperimentalPlayerHost`), dont la
 * stabilité ne doit pas dépendre d'une fonction en bêta.
 *
 * Le fichier est déjà dans la forme que MediaSource attend (`fmp4.ts`) : on lui confie l'en-tête,
 * puis les fragments dans l'ordre, une minute d'avance au plus, trente secondes derrière la tête
 * au plus. Un saut vide le tampon et repart du fragment qui couvre la position. Rien n'est
 * réécrit, rien n'est décodé par nous.
 *
 * Le fichier peut être encore en train d'arriver : `available()` dit jusqu'où il est écrit, et le
 * moteur attend la suite au lieu de déclarer la fin (`complete()` le dit).
 */

export interface OfflineSource {
  /** Les octets demandés, ou moins s'ils ne sont pas encore écrits. */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** Combien d'octets du fichier sont sur l'appareil. */
  available(): number;
  /** Le fichier est-il entier ? */
  complete(): boolean;
}

export interface OfflineEngineEvents {
  onError(message: string): void;
  /** Pour le journal du lecteur et la trace : ouverture, sauts, fin. */
  trace?(line: string): void;
}

/** Une minute d'avance : ~15 Mo à 2 Mb/s, ~30 Mo à 4 Mb/s — loin des plafonds de WebKit (105 Mo). */
const AHEAD_S = 60;
const BEHIND_S = 30;

type MediaSourceLike = MediaSource;

function createMediaSource(): MediaSourceLike {
  // iPhone : ManagedMediaSource seulement (iOS 17.1+). Partout ailleurs, MediaSource.
  const managed = (globalThis as { ManagedMediaSource?: { new (): MediaSource } }).ManagedMediaSource;
  if (managed) return new managed();
  if (typeof MediaSource === "undefined") throw new Error("MediaSource indisponible sur cet appareil");
  return new MediaSource();
}

export function offlinePlaybackSupported(mime: string): boolean {
  const managed = (globalThis as { ManagedMediaSource?: { isTypeSupported(t: string): boolean } }).ManagedMediaSource;
  if (managed) return managed.isTypeSupported(mime);
  return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
}

export class OfflineEngine {
  private mediaSource: MediaSourceLike | null = null;
  private buffer: SourceBuffer | null = null;
  private url: string | null = null;
  private init: Fmp4Init | null = null;
  private fragments: Fmp4Fragment[] = [];
  private scanned = 0;
  /** Le prochain fragment à confier au tampon. */
  private nextIndex = 0;
  private pumping = false;
  private closed = false;
  /** Change à chaque saut : une boucle d'ajout partie avant lui s'arrête d'elle-même. */
  private generation = 0;
  private ended = false;
  private readonly onTime = () => void this.pump();
  private readonly onSeeking = () => void this.seek(this.video.currentTime);

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: OfflineSource,
    private readonly duration: number | null,
    private readonly events: OfflineEngineEvents
  ) {}

  /** Ouvre le fichier et attache la source à l'élément ; rend le type MIME confié. */
  async open(startAt: number): Promise<string> {
    const head = await this.source.read(0, Math.min(this.source.available(), 4 * 1024 * 1024));
    const init = parseInit(head);
    if (!init) throw new Error("Le début du fichier n'est pas encore téléchargé");
    if (!offlinePlaybackSupported(init.mime)) throw new Error(`Format non lu par cet appareil (${init.mime})`);
    this.init = init;
    this.scanned = init.end;
    await this.rescan();

    const mediaSource = createMediaSource();
    this.mediaSource = mediaSource;
    // ManagedMediaSource exige que la lecture à distance soit coupée pour s'attacher.
    this.video.disableRemotePlayback = true;
    this.url = URL.createObjectURL(mediaSource);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MediaSource ne s'est pas ouverte")), 10_000);
      mediaSource.addEventListener("sourceopen", () => (clearTimeout(timer), resolve()), { once: true });
      this.video.src = this.url!;
    });
    this.buffer = mediaSource.addSourceBuffer(init.mime);
    if (this.duration && Number.isFinite(this.duration)) mediaSource.duration = this.duration;
    await this.append(init.bytes);
    this.events.trace?.(`hors ligne : ouvert, ${this.fragments.length} fragments sur l'appareil, ${init.mime}`);
    this.video.addEventListener("timeupdate", this.onTime);
    this.video.addEventListener("seeking", this.onSeeking);
    if (startAt > 0) this.video.currentTime = startAt;
    this.nextIndex = Math.max(0, fragmentIndexAt(this.fragments, startAt));
    void this.pump();
    return init.mime;
  }

  /** Où le fichier est lisible : jusqu'à la fin du dernier fragment présent. */
  playableUntil(): number {
    if (this.source.complete()) return this.duration ?? Infinity;
    const last = this.fragments[this.fragments.length - 1];
    return last ? last.time : 0;
  }

  /** Rapporte les fragments arrivés depuis la dernière lecture de l'index. */
  private async rescan(): Promise<void> {
    if (!this.init) return;
    const video = this.init.tracks.find((t) => t.kind === "video")!;
    const { fragments, next } = await scanFragments((o, l) => this.source.read(o, l), this.scanned, this.source.available(), video);
    this.fragments.push(...fragments);
    this.scanned = next;
  }

  private append(bytes: Uint8Array): Promise<void> {
    const buffer = this.buffer;
    if (!buffer) return Promise.reject(new Error("tampon fermé"));
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", fail);
        resolve();
      };
      const fail = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", fail);
        reject(new Error("le navigateur a refusé un fragment"));
      };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", fail);
      buffer.appendBuffer(bytes as BufferSource);
    });
  }

  private remove(from: number, to: number): Promise<void> {
    const buffer = this.buffer;
    if (!buffer || to <= from) return Promise.resolve();
    return new Promise<void>((resolve) => {
      buffer.addEventListener("updateend", () => resolve(), { once: true });
      buffer.remove(from, to);
    });
  }

  private bufferedEndAround(t: number): number {
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= t + 0.5 && ranges.end(i) >= t) return ranges.end(i);
    return t;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed || !this.buffer) return;
    this.pumping = true;
    const generation = this.generation;
    try {
      while (!this.closed && generation === this.generation) {
        const now = this.video.currentTime;
        // Derrière la tête : gardé trente secondes, pour revenir un peu en arrière sans relire.
        if (now - BEHIND_S > 1 && this.video.buffered.length && this.video.buffered.start(0) < now - BEHIND_S) {
          await this.remove(0, now - BEHIND_S);
          continue;
        }
        if (this.bufferedEndAround(now) - now >= AHEAD_S) break;
        if (this.nextIndex >= this.fragments.length) {
          await this.rescan();
          if (this.nextIndex < this.fragments.length) continue;
          if (this.source.complete() && !this.ended && this.mediaSource?.readyState === "open") {
            this.ended = true;
            this.mediaSource.endOfStream();
            this.events.trace?.("hors ligne : fin du fichier confiée");
          }
          break;
        }
        const fragment = this.fragments[this.nextIndex];
        const bytes = await this.source.read(fragment.offset, fragment.size);
        if (generation !== this.generation || this.closed) break;
        if (bytes.length < fragment.size) break;
        await this.append(normalizeFragment(bytes, fragment.offset));
        this.nextIndex += 1;
      }
    } catch (error) {
      if (!this.closed) this.events.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.pumping = false;
    }
    // Un fichier qui arrive encore : on repasse plus tard voir s'il a grandi.
    if (!this.closed && !this.ended && generation === this.generation && this.nextIndex >= this.fragments.length) {
      setTimeout(() => void this.pump(), 2000);
    }
  }

  private async seek(target: number): Promise<void> {
    if (this.closed || !this.buffer) return;
    const index = fragmentIndexAt(this.fragments, target);
    if (index < 0) return;
    // Déjà dans le tampon : rien à faire, la boucle d'ajout continue d'elle-même.
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= target && ranges.end(i) > target + 1) return;
    this.generation += 1;
    this.events.trace?.(`hors ligne : saut à ${target.toFixed(1)} s, fragment ${index}`);
    // Attendre l'ajout en cours avant de vider.
    while (this.buffer.updating) await new Promise((r) => this.buffer!.addEventListener("updateend", r, { once: true }));
    if (this.ended && this.mediaSource?.readyState === "ended") {
      // Rouvrir un flux déclaré fini : un `remove` le repasse en `open`.
      this.ended = false;
    }
    const end = this.mediaSource && Number.isFinite(this.mediaSource.duration) ? this.mediaSource.duration : 1e7;
    await this.remove(0, end);
    this.nextIndex = index;
    while (this.pumping) await new Promise((r) => setTimeout(r, 20));
    void this.pump();
  }

  close(): void {
    this.closed = true;
    this.video.removeEventListener("timeupdate", this.onTime);
    this.video.removeEventListener("seeking", this.onSeeking);
    try {
      this.video.removeAttribute("src");
      this.video.load();
    } catch {
      /* l'élément est déjà démonté */
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.buffer = null;
    this.mediaSource = null;
  }
}
