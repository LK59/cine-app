// Feeds remuxed segments to a real <video> element through MediaSource.
//
// This is the path that costs the least and gives the most: the browser decodes in hardware,
// composites the picture itself, drives its own audio clock, and handles HDR natively. Nothing
// here touches a pixel or a sample — it only decides what to hand over and when.
//
// Anything that goes wrong is reported, never worked around silently. A player that quietly falls
// back leaves you unable to tell a path that works from a path that was never used.

import type { SubtitleCue } from "./engine";
import type { Remuxer, RemuxPlan } from "./remuxer";

/** How far ahead of the playhead to keep buffered. Enough to ride out a slow read, not a download. */
const TARGET_BUFFER_SECONDS = 30;

/** How much already-played media to keep before evicting, so a short step back does not re-fetch. */
const KEEP_BEHIND_SECONDS = 30;

export interface MseCallbacks {
  /** Fatal: playback cannot continue on this path. The caller decides what to say and offer. */
  onError: (message: string) => void;
  /** Subtitle lines found in the stretch of file just read, already timed on the player's clock. */
  onSubtitles?: (cues: SubtitleCue[]) => void;
}

type MediaSourceCtor = typeof MediaSource | typeof ManagedMediaSource;

function sourceConstructor(): MediaSourceCtor | null {
  if (typeof window === "undefined") return null;
  // Preferred on iPhone: plain MediaSource is absent there, and the managed one lets the system
  // evict buffered media under pressure instead of the tab being killed.
  return window.ManagedMediaSource ?? (typeof MediaSource !== "undefined" ? MediaSource : null);
}

/** Whether this browser can play what the remuxer would produce, checked before any work starts. */
export function playabilityOf(plan: RemuxPlan): { ok: true } | { ok: false; reason: string } {
  const Source = sourceConstructor();
  if (!Source) return { ok: false, reason: "Ce navigateur ne propose pas MediaSource." };
  if (!Source.isTypeSupported(plan.videoMimeType)) {
    return { ok: false, reason: `Vidéo non prise en charge par ce navigateur : ${plan.videoMimeType}` };
  }
  if (plan.audioMimeType && !Source.isTypeSupported(plan.audioMimeType)) {
    return { ok: false, reason: `Audio non pris en charge par ce navigateur : ${plan.audioMimeType}` };
  }
  return { ok: true };
}

export class MseSource {
  private readonly source: MediaSource | ManagedMediaSource;
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private filling = false;
  private destroyed = false;
  private ended = false;
  /** Bumped by every seek, so appends already in flight are recognised as stale and dropped. */
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private delaySeconds = 0;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly remuxer: Remuxer,
    private readonly plan: RemuxPlan,
    private readonly callbacks: MseCallbacks,
    Source: MediaSourceCtor
  ) {
    this.source = new Source();
  }

  static async attach(
    video: HTMLVideoElement,
    remuxer: Remuxer,
    plan: RemuxPlan,
    callbacks: MseCallbacks
  ): Promise<MseSource> {
    const Source = sourceConstructor();
    if (!Source) throw new Error("Ce navigateur ne propose pas MediaSource.");

    const instance = new MseSource(video, remuxer, plan, callbacks, Source);
    await instance.open();
    return instance;
  }

  /** Where the player's clock sits relative to the file's. Already applied to every seek here. */
  get presentationDelay(): number {
    return this.delaySeconds;
  }

  private async open(): Promise<void> {
    // AirPlay cannot carry a managed stream, and Safari refuses to attach one until this is set.
    this.video.disableRemotePlayback = true;

    const opened = new Promise<void>((resolve) => {
      this.source.addEventListener("sourceopen", () => resolve(), { once: true });
    });

    try {
      // Preferred: the element holds the source object directly, with no URL to leak.
      (this.video as unknown as { srcObject: unknown }).srcObject = this.source;
    } catch {
      this.objectUrl = URL.createObjectURL(this.source as MediaSource);
      this.video.src = this.objectUrl;
    }
    if (!this.objectUrl && !(this.video as unknown as { srcObject: unknown }).srcObject) {
      this.objectUrl = URL.createObjectURL(this.source as MediaSource);
      this.video.src = this.objectUrl;
    }

    await opened;
    if (this.destroyed) return;

    this.videoBuffer = this.source.addSourceBuffer(this.plan.videoMimeType);
    this.videoBuffer.mode = "segments";
    if (this.plan.audioMimeType) {
      this.audioBuffer = this.source.addSourceBuffer(this.plan.audioMimeType);
      this.audioBuffer.mode = "segments";
    }

    await this.appendTo(this.videoBuffer, this.plan.videoInit, this.generation);
    if (this.audioBuffer && this.plan.audioInit) {
      await this.appendTo(this.audioBuffer, this.plan.audioInit, this.generation);
    }

    // The system says when it wants data; a page that fetches regardless gets throttled.
    this.source.addEventListener("startstreaming", this.request);
    this.video.addEventListener("timeupdate", this.request);
    this.video.addEventListener("seeking", this.request);

    await this.fill();
  }

  private readonly request = () => {
    void this.fill();
  };

  /** True while the system wants data. Plain MediaSource has no such signal, so it always does. */
  private get streamingWanted(): boolean {
    const managed = this.source as ManagedMediaSource;
    return typeof managed.streaming === "boolean" ? managed.streaming : true;
  }

  private bufferedEnd(): number {
    const buffer = this.videoBuffer;
    if (!buffer || buffer.buffered.length === 0) return this.video.currentTime;
    return buffer.buffered.end(buffer.buffered.length - 1);
  }

  private async fill(): Promise<void> {
    if (this.filling || this.destroyed || this.ended) return;
    this.filling = true;
    const generation = this.generation;

    try {
      while (!this.destroyed && this.generation === generation && this.streamingWanted) {
        if (this.bufferedEnd() - this.video.currentTime >= TARGET_BUFFER_SECONDS) break;

        const segment = await this.remuxer.nextSegment();
        if (this.generation !== generation || this.destroyed) break;

        if (!segment) {
          this.ended = true;
          if (this.source.readyState === "open") this.source.endOfStream();
          break;
        }

        // The delay is only known once the first segment has been built, and the duration has to
        // account for it: the media now ends that much later than the file does.
        if (this.delaySeconds === 0) {
          this.delaySeconds = this.remuxer.diagnostics().presentationDelaySeconds;
          if (this.source.readyState === "open" && this.plan.durationSeconds > 0) {
            this.source.duration = this.plan.durationSeconds + this.delaySeconds;
          }
        }

        if (segment.subtitles.length > 0) this.callbacks.onSubtitles?.(segment.subtitles);
        if (segment.video && this.videoBuffer) await this.appendTo(this.videoBuffer, segment.video, generation);
        if (segment.audio && this.audioBuffer) await this.appendTo(this.audioBuffer, segment.audio, generation);
      }
    } catch (error) {
      if (!this.destroyed) this.callbacks.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.filling = false;
    }
  }

  private appendTo(buffer: SourceBuffer, data: Uint8Array, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed || this.generation !== generation) return resolve();

      const done = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        reject(new Error("Le navigateur a refusé un segment remultiplexé."));
      };
      buffer.addEventListener("updateend", done);
      buffer.addEventListener("error", failed);

      try {
        buffer.appendBuffer(data as BufferSource);
      } catch (error) {
        buffer.removeEventListener("updateend", done);
        buffer.removeEventListener("error", failed);
        // The buffer is full rather than broken: drop what is behind the playhead and let the
        // next pass try again. Any other failure is real and must be surfaced.
        if (error instanceof DOMException && error.name === "QuotaExceededError") {
          this.evict();
          resolve();
        } else {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  private evict(): void {
    const until = this.video.currentTime - KEEP_BEHIND_SECONDS;
    if (until <= 0) return;
    for (const buffer of [this.videoBuffer, this.audioBuffer]) {
      if (buffer && !buffer.updating && buffer.buffered.length > 0 && buffer.buffered.start(0) < until) {
        try {
          buffer.remove(0, until);
        } catch {
          // A remove that the browser declines is not worth failing playback over.
        }
      }
    }
  }

  /**
   * Moves playback to a point on the *player's* clock. The remuxer works on the file's clock, so
   * the presentation delay is taken off here and nowhere else.
   */
  seek(playerSeconds: number): Promise<void> {
    this.pending = this.pending.then(() => this.performSeek(playerSeconds)).catch((error) => {
      if (!this.destroyed) this.callbacks.onError(error instanceof Error ? error.message : String(error));
    });
    return this.pending;
  }

  private async performSeek(playerSeconds: number): Promise<void> {
    if (this.destroyed) return;
    this.generation += 1;
    this.ended = false;

    for (const buffer of [this.videoBuffer, this.audioBuffer]) {
      if (!buffer) continue;
      if (buffer.updating) {
        try {
          buffer.abort();
        } catch {
          // Aborting a buffer whose source has closed throws; nothing to do about it here.
        }
      }
      await this.clear(buffer);
    }

    this.remuxer.seekTo(Math.max(0, playerSeconds - this.delaySeconds));
    this.video.currentTime = playerSeconds;
    await this.fill();
  }

  private clear(buffer: SourceBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (buffer.buffered.length === 0 || this.source.readyState !== "open") return resolve();
      const done = () => {
        buffer.removeEventListener("updateend", done);
        resolve();
      };
      buffer.addEventListener("updateend", done);
      try {
        buffer.remove(0, Infinity);
      } catch {
        buffer.removeEventListener("updateend", done);
        resolve();
      }
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;

    this.source.removeEventListener("startstreaming", this.request);
    this.video.removeEventListener("timeupdate", this.request);
    this.video.removeEventListener("seeking", this.request);

    try {
      if (this.source.readyState === "open") this.source.endOfStream();
    } catch {
      // Already closed by the element being torn down first.
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    try {
      (this.video as unknown as { srcObject: unknown }).srcObject = null;
    } catch {
      this.video.removeAttribute("src");
    }
  }
}
