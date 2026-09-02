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

/**
 * The depth that is fetched no matter what the system says.
 *
 * ManagedMediaSource tells a page when to stream and when to stop, and a page that ignores it
 * gets throttled — but obeying it unconditionally means that if it says "stop" while the buffer
 * in front of the playhead is empty, nothing is ever fetched again and the player sits there
 * loading forever. Below this depth the media is needed to play at all, so it is fetched; above
 * it, the system decides.
 */
const MIN_BUFFER_SECONDS = 8;

/** How long a playhead with no media under it is tolerated before a seek is forced to reach it. */
const STALL_TIMEOUT_MS = 700;

/** How often that is checked. Often enough that a recovery is not itself the thing you notice. */
const WATCHDOG_MS = 250;

/**
 * How far the media being read may sit from the playhead before the reader is judged misplaced.
 *
 * Comfortably more than a segment, so ordinary reading ahead is never mistaken for it, and far
 * less than the distance any real seek covers.
 */
const MISPLACED_SECONDS = 10;

/** How much already-played media to keep before evicting, so a short step back does not re-fetch. */
const KEEP_BEHIND_SECONDS = 30;

export interface MseCallbacks {
  /** Fatal: playback cannot continue on this path. The caller decides what to say and offer. */
  onError: (message: string) => void;
  /** Subtitle lines found in the stretch of file just read, already timed on the player's clock. */
  onSubtitles?: (cues: SubtitleCue[]) => void;
  /** Something was refused but playback continues — a seek the file cannot serve, typically. */
  onWarning?: (message: string) => void;
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
  /** The read loop in flight, if any. A seek has to let it finish before moving the reader. */
  private fillTask: Promise<void> | null = null;
  private destroyed = false;
  private ended = false;
  /** Bumped by every seek, so appends already in flight are recognised as stale and dropped. */
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  /** The most recent seek asked for. Dragging a scrub bar asks for dozens; only the last matters. */
  private requestedSeek: number | null = null;
  private delaySeconds = 0;
  /** Where the last seek this object performed landed, so its own `seeking` event is not re-served. */
  private lastSeekTarget = -1;
  private lastAppendAt = 0;
  private seeksServed = 0;
  private recoveries = 0;
  private recoveryTarget = -1;
  private recoveryStreak = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly remuxer: Remuxer,
    private plan: RemuxPlan,
    private readonly callbacks: MseCallbacks,
    Source: MediaSourceCtor
  ) {
    this.source = new Source();
  }

  static async attach(
    video: HTMLVideoElement,
    remuxer: Remuxer,
    plan: RemuxPlan,
    callbacks: MseCallbacks,
    startSeconds = 0
  ): Promise<MseSource> {
    const Source = sourceConstructor();
    if (!Source) throw new Error("Ce navigateur ne propose pas MediaSource.");

    const instance = new MseSource(video, remuxer, plan, callbacks, Source);
    await instance.open(startSeconds);
    return instance;
  }

  /** Where the player's clock sits relative to the file's. Already applied to every seek here. */
  get presentationDelay(): number {
    return this.delaySeconds;
  }

  private async open(startSeconds: number): Promise<void> {
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

    // Positioned before the first read, not after it. Filling thirty seconds from the beginning
    // and then throwing all of it away is what made resuming a part-watched episode feel slow.
    if (startSeconds > 1 && this.remuxer.seekable) {
      this.remuxer.seekTo(startSeconds);
      this.lastSeekTarget = startSeconds;
      this.video.currentTime = startSeconds;
    }

    // The system says when it wants data; a page that fetches regardless gets throttled.
    this.source.addEventListener("startstreaming", this.request);
    this.video.addEventListener("timeupdate", this.request);
    this.video.addEventListener("waiting", this.request);
    // Not merely a hint to fetch more. On this path the transport controls write straight to the
    // element, as they do for any <video>, so this event is the *only* notice that the viewer
    // asked to be somewhere else. Without it the element waits at a time nothing will ever be
    // appended to, while the reader keeps grinding forward from wherever it was — which looks
    // exactly like the player decoding every frame up to the target before resuming.
    this.video.addEventListener("seeking", this.onSeeking);
    this.lastAppendAt = Date.now();
    this.watchdogTimer = setInterval(this.watchdog, WATCHDOG_MS);

    await this.fill();
  }

  private readonly request = () => {
    void this.fill();
  };

  private readonly onSeeking = () => {
    if (this.destroyed) return;
    const target = this.video.currentTime;
    // This object's own move, already being served — serving it again would clear the buffers
    // it is in the middle of refilling.
    if (Math.abs(target - this.lastSeekTarget) < 0.25) return void this.fill();
    // A step inside what is already buffered needs no work from the file at all.
    if (this.isBufferedAt(target)) return void this.fill();
    void this.seek(target);
  };

  /** How far the playhead is from the nearest media, or 0 when it is standing on some. */
  private distanceToMedia(seconds: number): number {
    const ranges = this.videoBuffer?.buffered;
    if (!ranges || ranges.length === 0) return Infinity;
    let best = Infinity;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= seconds && seconds < ranges.end(i)) return 0;
      best = Math.min(best, Math.abs(ranges.start(i) - seconds), Math.abs(ranges.end(i) - seconds));
    }
    return best;
  }

  private isBufferedAt(seconds: number): boolean {
    const ranges = this.videoBuffer?.buffered;
    if (!ranges) return false;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= seconds && seconds < ranges.end(i)) return true;
    }
    return false;
  }

  /** True while the system wants data. Plain MediaSource has no such signal, so it always does. */
  private get streamingWanted(): boolean {
    const managed = this.source as ManagedMediaSource;
    return typeof managed.streaming === "boolean" ? managed.streaming : true;
  }

  /** How much media sits between the playhead and the end of its own run. */
  private get lead(): number {
    return this.bufferedEnd() - this.video.currentTime;
  }

  /**
   * How far the media runs on from the playhead without a gap.
   *
   * The range containing the playhead, not simply the last one. After a seek backwards there can
   * be a later range left over, and measuring against that would report a deep buffer while the
   * playhead sits in front of nothing at all — the player would then quietly stop fetching.
   */
  private bufferedEnd(): number {
    const ranges = this.videoBuffer?.buffered;
    const now = this.video.currentTime;
    if (!ranges) return now;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= now + 0.1 && now < ranges.end(i)) return ranges.end(i);
    }
    return now;
  }

  private fill(): Promise<void> {
    // Held onto rather than merely guarded against. A seek must wait for a read already in
    // flight: moving the reader out from under it would leave the demuxer mid-cluster. The
    // earlier version only refused to start a second loop, so a seek's own refill could return
    // immediately without doing anything and playback would sit there waiting.
    if (this.fillTask) return this.fillTask;
    this.fillTask = this.runFill().finally(() => {
      this.fillTask = null;
    });
    return this.fillTask;
  }

  private async runFill(): Promise<void> {
    if (this.destroyed || this.ended) return;
    const generation = this.generation;

    try {
      while (!this.destroyed && this.generation === generation) {
        const lead = this.lead;
        if (lead >= TARGET_BUFFER_SECONDS) break;
        // Above the floor the system's word is final; below it, the media is needed to play at
        // all and a refusal would strand the player with an empty buffer and a spinner.
        if (lead >= MIN_BUFFER_SECONDS && !this.streamingWanted) break;
        // A seek is waiting. Reading thirty more seconds of a place the viewer has already left
        // is what makes a second seek feel like it does nothing for several seconds.
        if (this.requestedSeek !== null) break;

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
        // A seek arrived while those were in flight: this loop's appends were discarded, so its
        // reading of where the media is would be about a position no longer being served.
        if (this.generation !== generation || this.destroyed) break;

        this.nudgeIntoBuffer();
        this.lastAppendAt = Date.now();

        // The reader is filling a place the viewer is not. Something failed to tell us they
        // moved — an event that did not fire, a seek that did not reach here — and the reader
        // would otherwise read its way there one segment at a time, which is exactly what a
        // seek looks like when it appears to recalculate the whole film. The watchdog cannot
        // catch this on its own: media *is* arriving, just nowhere useful.
        if (this.distanceToMedia(this.video.currentTime) > MISPLACED_SECONDS) {
          if (this.recover(this.video.currentTime)) break;
        }
      }
    } catch (error) {
      if (!this.destroyed) this.callbacks.onError(error instanceof Error ? error.message : String(error));
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

  /**
   * Moves the playhead onto the media, when it has landed just short of it.
   *
   * A seek starts reading at the indexed cluster at or before the requested time, but everything
   * this path produces is shifted later by the presentation delay. Land on an index point exactly
   * and the media therefore begins a fifth of a second *after* the playhead — a gap the element
   * will sit in front of indefinitely, waiting for data that is never coming. The step is far too
   * small to see, and it is the difference between a seek that works and one that hangs.
   */
  private nudgeIntoBuffer(): void {
    const ranges = this.videoBuffer?.buffered;
    if (!ranges || ranges.length === 0 || this.destroyed) return;

    const now = this.video.currentTime;
    let start: number | null = null;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= now && now < ranges.end(i)) return; // already on media
      if (ranges.start(i) > now && (start === null || ranges.start(i) < start)) start = ranges.start(i);
    }
    // Only a gap the size of the delay is closed this way. A larger one is a real hole in the
    // stream, and stepping over it silently would hide a genuine fault.
    if (start === null || start - now > 1) return;

    this.lastSeekTarget = start;
    this.video.currentTime = start;
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
    // Coalesced, not queued. Dragging a scrub bar across a film asks to be in dozens of places;
    // serving each in turn means every one of them is stale before its media arrives, and the
    // picture never catches up with the finger.
    this.requestedSeek = playerSeconds;
    this.pending = this.pending
      .then(() => {
        const target = this.requestedSeek;
        if (target === null || this.destroyed) return;
        // Deliberately not cleared here. The flag is what tells the read loop to stop filling a
        // place the viewer has left, and it has to stay up for as long as that is still true —
        // which is until the reader has actually been moved, inside performSeek.
        return this.performSeek(target);
      })
      .catch((error) => {
        if (!this.destroyed) this.callbacks.onError(error instanceof Error ? error.message : String(error));
      });
    return this.pending;
  }

  /**
   * Stops the read loop and waits for it to come back.
   *
   * The caller needs this before moving anything the loop is reading through: a track swap that
   * lands mid-read would produce one segment describing one track and carrying another's samples.
   */
  async quiesce(): Promise<void> {
    this.generation += 1;
    await this.fillTask?.catch(() => {});
  }

  /**
   * Points the audio buffer at a different track, in place.
   *
   * Nothing about the video is touched, so the picture never stops. The initialisation segment
   * is what a source buffer decodes by; replacing it and refilling is all a language change is.
   */
  async replaceAudio(mimeType: string | null, init: Uint8Array | null): Promise<void> {
    const buffer = this.audioBuffer;
    if (!buffer || !mimeType || !init || this.destroyed) return;
    this.generation += 1;

    if (mimeType !== this.plan.audioMimeType) {
      if (typeof buffer.changeType !== "function") {
        throw new Error("Ce navigateur ne sait pas changer de codec audio en cours de lecture.");
      }
      buffer.changeType(mimeType);
    }
    this.plan = { ...this.plan, audioMimeType: mimeType, audioInit: init };

    await this.clear(buffer);
    await this.appendTo(buffer, init, this.generation);
  }

  private async performSeek(playerSeconds: number): Promise<void> {
    if (this.destroyed) return;

    // A file with no index cannot be reached at a time. Restarting from the beginning and
    // reading forward would look like the player thinking very hard and then, minutes later,
    // arriving — so it is refused, and playback carries on where it was.
    if (!this.remuxer.seekable && playerSeconds > 1) {
      this.callbacks.onWarning?.("Ce fichier n'a pas d'index de recherche : la navigation n'est pas possible.");
      if (this.lastSeekTarget >= 0) this.video.currentTime = this.lastSeekTarget;
      return;
    }

    this.generation += 1;
    this.ended = false;
    this.lastSeekTarget = playerSeconds;
    this.seeksServed += 1;
    // The refill starting below deserves the same grace as any other: without this the watchdog
    // sees a playhead on nothing, does not know a seek has just served it, and seeks again to
    // the very same place — doubling the work at exactly the moment it is most wanted elsewhere.
    this.lastAppendAt = Date.now();

    // The loop breaks on the generation check, but only once whatever read it is awaiting comes
    // back. Moving the reader before then would corrupt it.
    await this.fillTask?.catch(() => {});

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
    // Only when the element is not already there: reassigning would fire another seeking event
    // and start this over.
    if (Math.abs(this.video.currentTime - playerSeconds) > 0.05) this.video.currentTime = playerSeconds;

    // Served: the reader is where it was asked to be. Anything asked for after this point is a
    // new seek, and the refill below is free to run.
    if (this.requestedSeek === playerSeconds) this.requestedSeek = null;

    // Not awaited. A seek is finished the moment the reader is repositioned; waiting for thirty
    // seconds of media to be fetched before admitting so means the next seek queues behind a
    // download of a place the viewer has already left.
    void this.fill();
  }

  private clear(buffer: SourceBuffer): Promise<void> {
    return new Promise((resolve) => {
      if (buffer.buffered.length === 0 || this.source.readyState !== "open") return resolve();

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        buffer.removeEventListener("updateend", finish);
        resolve();
      };
      // Every seek waits on this. A browser that declines to answer would otherwise wedge the
      // queue permanently, and every later seek behind it.
      const timer = setTimeout(finish, 1500);
      buffer.addEventListener("updateend", finish);

      try {
        // A finite end rather than Infinity: it is what the specification's examples use and
        // what every implementation is exercised against.
        buffer.remove(0, Number.isFinite(this.source.duration) ? this.source.duration + 1 : 1e9);
      } catch {
        finish();
      }
    });
  }

  /**
   * The safety net, and the only part of this that does not depend on being told anything.
   *
   * Everything else here reacts to an event: the element announcing a seek, the system asking
   * for data, a buffer reporting an append. Each of those can fail to arrive — a browser that
   * does not fire seeking in some state, a system that stops asking and never starts again, an
   * append quietly rejected — and the symptom is always identical and always the same fault:
   * the playhead is somewhere no media is, and the reader is filling somewhere else.
   *
   * So rather than trying to enumerate the causes, this watches the one fact that matters and
   * seeks to wherever the viewer actually is. It is checked on a timer precisely because the
   * failure mode is that no event comes.
   */
  private readonly watchdog = () => {
    if (this.destroyed || this.ended || !this.videoBuffer) return;

    const now = this.video.currentTime;
    // On media, or a seek already on its way to it: nothing to do.
    if (this.isBufferedAt(now) || this.requestedSeek !== null) return;

    // A read is in progress, so media is on its way; whether it is on its way to the right place
    // is the read loop's own business, and it checks. Waiting on a clock instead would mean
    // guessing how long a segment takes to arrive — and guessing short, as a 4K file over a slow
    // link showed, means seeking again to the very place already being fetched.
    if (this.fillTask) return;

    // Nothing is being read and the playhead is on nothing: whatever failed to say so, the
    // viewer is somewhere this player is not serving.
    if (Date.now() - this.lastAppendAt < STALL_TIMEOUT_MS) return;
    this.recover(now);
  };

  /**
   * Seeks to where the viewer is, unless that has already been tried and did not help.
   *
   * Both recovery routes converge here so they share one limit. Without it, a target the file
   * genuinely cannot serve — an index pointing somewhere the media is not — turns a recovery
   * into a loop that seeks, fails to arrive, and seeks again as fast as it can.
   */
  private recover(target: number): boolean {
    if (Math.abs(target - this.recoveryTarget) < 1) {
      this.recoveryStreak += 1;
      if (this.recoveryStreak > 3) {
        this.callbacks.onWarning?.("Impossible d'atteindre cette position dans le fichier.");
        return false;
      }
    } else {
      this.recoveryTarget = target;
      this.recoveryStreak = 1;
    }
    this.recoveries += 1;
    void this.seek(target);
    return true;
  }

  /** What the technical panel shows. Enough to tell a stall apart from a refusal to fetch. */
  get debug(): Record<string, string> {
    const ranges = this.videoBuffer?.buffered;
    const spans: string[] = [];
    for (let i = 0; ranges && i < ranges.length; i++) {
      spans.push(`${ranges.start(i).toFixed(0)}–${ranges.end(i).toFixed(0)}`);
    }
    return {
      "Tampon vidéo": spans.join(" · ") || "vide",
      "Avance sur la tête": `${this.lead.toFixed(1)} s`,
      "MediaSource": `${this.source.readyState}${this.streamingWanted ? "" : " · en pause"}`,
      "Lecture en cours": this.fillTask ? "oui" : "non",
      "Sauts servis": `${this.seeksServed}${this.recoveries > 0 ? ` · ${this.recoveries} reprises` : ""}`,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;

    this.source.removeEventListener("startstreaming", this.request);
    this.video.removeEventListener("timeupdate", this.request);
    this.video.removeEventListener("waiting", this.request);
    this.video.removeEventListener("seeking", this.onSeeking);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;

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
