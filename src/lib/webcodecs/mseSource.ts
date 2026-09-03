// Feeds remuxed segments to a real <video> element through MediaSource.
//
// This is the path that costs the least and gives the most: the browser decodes in hardware,
// composites the picture itself, drives its own audio clock, and handles HDR natively. Nothing
// here touches a pixel or a sample — it only decides what to hand over and when.
//
// Anything that goes wrong is reported, never worked around silently. A player that quietly falls
// back leaves you unable to tell a path that works from a path that was never used.

import type { Remuxer, RemuxPlan, TrackedCue } from "./remuxer";

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

/** How long repeated recoveries at one spot keep counting against each other. */
const RECOVERY_WINDOW_MS = 5000;

/** Refused appends in a row before playback is declared broken rather than merely interrupted. */
const MAX_APPEND_FAILURES = 3;

/** How long a playhead with no media under it is tolerated before a seek is forced to reach it. */
const STALL_TIMEOUT_MS = 700;

/**
 * How long after pressing play the position from the pause is still defended.
 *
 * The jump does not necessarily happen the instant playback resumes: the element can start, find
 * nothing where it was, and move on a moment later. Long enough to cover that, short enough that
 * it can never be mistaken for fighting a viewer who has moved on.
 */
const RESUME_GUARD_MS = 1500;

/**
 * How long the clock is watched after pressing pause, waiting for it to come to rest.
 *
 * It does not stop where the button was pressed: the sound already handed to the hardware plays
 * out over the next fraction of a second and the clock follows it. That fraction was heard, so it
 * is part of what has been watched — anchoring before it and returning there on resume replays it.
 */
const PAUSE_SETTLE_MS = 1000;

/**
 * How far ahead of the pause a resume may land before it counts as a discontinuity.
 *
 * Measured on the device: the picture freezes where the button was pressed, but the sound the
 * hardware already held plays on for about half a second, and the clock reports that at the
 * moment of resuming — half a second ahead. Nothing was skipped; it was heard while the picture
 * stood still. Pulling it back replays it and shows the wrong frame for a moment, which is the
 * flicker this once caused. Only a gap far larger than the drain is a real discontinuity: media
 * the system reclaimed while nothing was playing, which runs to seconds.
 */
const RESUME_TOLERANCE_SECONDS = 1.5;

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
  onSubtitles?: (cues: TrackedCue[]) => void;
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

/** How long one buffer operation may go unanswered before the queue moves on without it. */
const BUFFER_OPERATION_TIMEOUT_MS = 4000;

/**
 * Serialises everything done to one source buffer.
 *
 * MediaSource permits exactly one operation per buffer at a time: starting a second while the
 * first is still running throws, and that throw used to surface as a fatal playback error even
 * though nothing was actually broken. Appends, removals and codec changes all come through here
 * in order, so overlapping is impossible rather than merely unlikely — which matters because the
 * things that touch a buffer are driven by unrelated events (a seek, a language change, the
 * eviction of played media) that can land in the same instant.
 */
class BufferQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly buffer: SourceBuffer) {}

  enqueue(operation: () => void): Promise<void> {
    const run = this.chain.then(() => this.runOne(operation));
    // The queue outlives a failed operation: one refused append must not wedge every later one.
    this.chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  private runOne(operation: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Passed through untouched rather than re-wrapped: a full buffer is signalled by the type
      // of what is thrown, and coercing it to a plain Error loses exactly the distinction
      // between "make room and carry on" and "this segment is bad".
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.buffer.removeEventListener("updateend", onEnd);
        this.buffer.removeEventListener("error", onFail);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onEnd = () => finish();
      const onFail = () => finish(new Error("Le navigateur a refusé une opération sur le tampon."));
      // A browser that answers neither must not hold the queue for the rest of the session.
      const timer = setTimeout(() => finish(), BUFFER_OPERATION_TIMEOUT_MS);

      this.buffer.addEventListener("updateend", onEnd);
      this.buffer.addEventListener("error", onFail);
      try {
        operation();
        // changeType, and a removal of nothing, finish without ever going busy.
        if (!this.buffer.updating) finish();
      } catch (error) {
        finish(error);
      }
    });
  }
}

export class MseSource {
  private readonly source: MediaSource | ManagedMediaSource;
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;
  private videoOps: BufferQueue | null = null;
  private audioOps: BufferQueue | null = null;
  /** Consecutive refused appends. A single one is worth retrying; a run of them is not. */
  private appendFailures = 0;
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
  /** Where the picture froze when the viewer pressed pause. Resume lands exactly there. */
  private pauseAnchor: number | null = null;
  private resumeDeadline = 0;
  private resumeStartedAt = 0;
  private pauseSettleTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The last pause and resume, in positions.
   *
   * Written down because the remaining flicker cannot be reasoned about any further from here:
   * nothing in this file moves the playhead when the buffer covers it, and the device says it
   * does. Four numbers settle what a description cannot — where it stopped, where it came back,
   * and where it was one tick later.
   */
  private resumeTrace: {
    paused: number;
    settled: number;
    asserted: number | null;
    play: number;
    tick: number | null;
  } | null = null;
  private pauseAssertTimer: ReturnType<typeof setTimeout> | null = null;
  private seeksServed = 0;
  private recoveries = 0;
  private recoveryTarget = -1;
  private recoveryStreak = 0;
  private lastRecoveryAt = 0;
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
    this.videoOps = new BufferQueue(this.videoBuffer);
    if (this.plan.audioMimeType) {
      this.audioBuffer = this.source.addSourceBuffer(this.plan.audioMimeType);
      this.audioBuffer.mode = "segments";
      this.audioOps = new BufferQueue(this.audioBuffer);
    }

    await this.appendTo(this.videoOps, this.plan.videoInit, this.generation);
    if (this.audioOps && this.plan.audioInit) {
      await this.appendTo(this.audioOps, this.plan.audioInit, this.generation);
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
    this.video.addEventListener("pause", this.onPause);
    this.video.addEventListener("play", this.onPlay);
    this.video.addEventListener("playing", this.request);
    this.lastAppendAt = Date.now();
    this.watchdogTimer = setInterval(this.watchdog, WATCHDOG_MS);

    await this.fill();
  }

  private readonly request = () => {
    // The first tick after resuming is where a jump would show, so it is recorded before
    // anything here has a chance to act on it.
    if (this.resumeTrace && !Number.isNaN(this.resumeTrace.play) && this.resumeTrace.tick === null) {
      this.resumeTrace.tick = this.video.currentTime;
    }
    // Playback advancing is also the first moment a jump on resume becomes visible.
    if (this.pauseAnchor !== null) this.holdPausePosition();
    void this.fill();
  };

  /**
   * Remembers exactly where the picture stopped.
   *
   * The element's clock does not necessarily stop where the button was pressed: the audio the
   * system has already handed to the hardware plays out over the next fraction of a second, and
   * the clock follows the sound. Resuming then starts from wherever it drifted to, which reads
   * as the film having quietly continued while paused and jumping to catch up.
   */
  private readonly onPause = () => {
    if (this.destroyed) return;
    this.pauseAnchor = this.video.currentTime;
    this.resumeTrace = { paused: this.pauseAnchor, settled: this.pauseAnchor, asserted: null, play: NaN, tick: null };

    // Re-stated while the picture is standing still, which is the only moment it costs nothing.
    //
    // The half second that appears at the instant of resuming is the sound the hardware still
    // held: it plays on past the frozen picture, and the clock reports it all at once when
    // playback restarts. By then there is no good answer — pulling it back shows the wrong frame
    // while the seek settles, and leaving it skips half a second of picture. Asking the element
    // to be where it already is, while paused, empties that queue instead, so there is nothing
    // left to arrive late. Whether it works is visible in the trace: the resume then departs from
    // exactly where the pause stopped.
    if (this.pauseAssertTimer) clearTimeout(this.pauseAssertTimer);
    this.pauseAssertTimer = setTimeout(() => {
      this.pauseAssertTimer = null;
      const anchor = this.pauseAnchor;
      if (this.destroyed || anchor === null || !this.video.paused) return;
      this.lastSeekTarget = anchor;
      this.video.currentTime = anchor;
      if (this.resumeTrace) this.resumeTrace.asserted = anchor;
    }, PAUSE_SETTLE_MS);
    // Followed until it comes to rest, so the anchor is where the film actually stopped being
    // heard rather than where the button was pressed. On a platform that stops dead — every
    // desktop browser — the first sample is already the last, and this costs nothing.
    if (this.pauseSettleTimer) clearInterval(this.pauseSettleTimer);
    const deadline = Date.now() + PAUSE_SETTLE_MS;
    this.pauseSettleTimer = setInterval(() => {
      const stop = this.destroyed || this.pauseAnchor === null || !this.video.paused || Date.now() > deadline;
      if (stop) {
        if (this.pauseSettleTimer) clearInterval(this.pauseSettleTimer);
        this.pauseSettleTimer = null;
        return;
      }
      const settled = this.pauseAnchor;
      if (settled !== null && this.video.currentTime > settled) {
        this.pauseAnchor = this.video.currentTime;
        if (this.resumeTrace) this.resumeTrace.settled = this.video.currentTime;
      }
    }, 80);
  };

  private readonly onPlay = () => {
    if (this.destroyed) return;
    // Held for a moment rather than settled on the spot: the element fires this as soon as play
    // is called, which is before it has actually resumed and therefore before it can have
    // jumped. Checked again as playback gets going, until the window closes.
    this.resumeStartedAt = Date.now();
    if (this.resumeTrace) this.resumeTrace.play = this.video.currentTime;
    this.resumeDeadline = this.resumeStartedAt + RESUME_GUARD_MS;
    const moved = this.holdPausePosition();

    // Nothing moves the playhead while paused, so any settling owed is settled here — before the
    // watchdog's own delay, which would otherwise be a visible wait at the moment of pressing
    // play. Skipped when the position was just put back, which has already settled it.
    if (!moved) this.nudgeIntoBuffer();
    void this.fill();
  };

  /**
   * Puts playback back where it was stopped, if resuming has moved it on.
   *
   * Two things move it. The element's clock follows the sound, and the sound already handed to
   * the hardware plays out past the button press. And the system may reclaim buffered media while
   * nothing is playing — it is allowed to, and on a phone it does — so the element can come back
   * to find nothing where it was and carry on from the nearest media it still holds. Both look
   * identical from here: the film quietly continued while it was stopped.
   */
  private holdPausePosition(): boolean {
    const anchor = this.pauseAnchor;
    if (anchor === null || this.destroyed) return false;
    if (Date.now() > this.resumeDeadline) {
      this.pauseAnchor = null;
      return false;
    }

    // Measured against where playing could legitimately have got to, never against the anchor
    // itself. Playback passes the anchor within a tenth of a second of resuming, and reading that
    // as a jump is a yank backwards — and, when the media there has been reclaimed, a full
    // re-read for nothing. Only a playhead further along than time can account for has jumped.
    const rate = this.video.playbackRate || 1;
    const reachable = anchor + ((Date.now() - this.resumeStartedAt) / 1000) * rate;
    if (this.video.currentTime <= reachable + RESUME_TOLERANCE_SECONDS) return false;

    this.pauseAnchor = null;
    if (this.isBufferedAt(anchor)) {
      this.lastSeekTarget = anchor;
      this.video.currentTime = anchor;
      return true;
    }
    // The media that was there is gone. Fetching it again is the whole point — this is the case
    // the guard exists for, and the one where giving up leaves the jump in place.
    void this.seek(anchor);
    return true;
  }

  private readonly onSeeking = () => {
    if (this.destroyed) return;
    const target = this.video.currentTime;
    // This object's own move, already being served — serving it again would clear the buffers
    // it is in the middle of refilling.
    if (Math.abs(target - this.lastSeekTarget) < 0.25) return void this.fill();
    // A step inside what is already buffered needs no work from the file at all.
    if (this.isBufferedAt(target)) return void this.fill();
    // A deliberate move settles the question of where playback belongs.
    this.pauseAnchor = null;
    void this.seek(target);
  };

  /**
   * What the element can actually play.
   *
   * Not the video buffer's own ranges: an element plays only where *every* track it is using has
   * media, and the media element reports precisely that intersection. Audio after a seek starts
   * consistently a fraction of a second later than video, so measuring the video buffer alone is
   * optimistic by exactly that much — it reports the playhead as covered while the element is
   * still waiting for sound.
   */
  private get playable(): TimeRanges {
    return this.video.buffered;
  }

  /** How far the playhead is from the nearest media, or 0 when it is standing on some. */
  private distanceToMedia(seconds: number): number {
    const ranges = this.playable;
    if (ranges.length === 0) return Infinity;
    let best = Infinity;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= seconds && seconds < ranges.end(i)) return 0;
      best = Math.min(best, Math.abs(ranges.start(i) - seconds), Math.abs(ranges.end(i) - seconds));
    }
    return best;
  }

  private isBufferedAt(seconds: number): boolean {
    return this.distanceToMedia(seconds) === 0;
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
    const ranges = this.playable;
    const now = this.video.currentTime;
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
        if (segment.video && this.videoOps) await this.appendTo(this.videoOps, segment.video, generation);
        if (segment.audio && this.audioOps) await this.appendTo(this.audioOps, segment.audio, generation);
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
      if (this.destroyed) return;
      // Reported by the viewer as a freeze that a second seek or a language change undoes — so
      // nothing was actually lost, and declaring playback over was the wrong answer. A refused
      // append is retried from where the playhead is; only a run of them is a real fault.
      this.appendFailures += 1;
      if (this.appendFailures <= MAX_APPEND_FAILURES && this.recover(this.video.currentTime)) {
        this.callbacks.onWarning?.("Reprise après un segment refusé.");
        return;
      }
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
    }
  }

  private async appendTo(queue: BufferQueue, data: Uint8Array, generation: number): Promise<void> {
    if (this.destroyed || this.generation !== generation) return;
    try {
      await queue.enqueue(() => queue.buffer.appendBuffer(data as BufferSource));
      this.appendFailures = 0;
    } catch (error) {
      // The buffer is full rather than broken: drop what is behind the playhead and try again
      // on the next pass.
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        this.evict();
        return;
      }
      throw error;
    }
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
    const ranges = this.playable;
    // Never while paused. The frame on screen is already drawn and needs nothing; moving the
    // playhead under a viewer who has stopped is a picture that jumps on its own, and then
    // resumes somewhere other than where they left it.
    if (ranges.length === 0 || this.destroyed || this.video.paused) return;

    const now = this.video.currentTime;
    let start: number | null = null;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= now && now < ranges.end(i)) return; // already on media
      if (ranges.start(i) > now && (start === null || ranges.start(i) < start)) start = ranges.start(i);
    }
    // Only a gap the size of the presentation delay is closed this way — that is the one this
    // exists for. A whole second was far too generous: on resume it could step a noticeable
    // distance forward, which is its own kind of jump. Anything larger is a real hole in the
    // stream, and stepping over it silently would hide a genuine fault.
    if (start === null || start - now > this.delaySeconds + 0.15) return;

    this.lastSeekTarget = start;
    // A move made on purpose, and the resume guard must not mistake it for one. Left standing,
    // the anchor makes the next event read this step forward as a jump and pull it back — a
    // frame from further on, briefly, then the right one. Settling the position here is what the
    // anchor was for, so it has done its job.
    this.pauseAnchor = null;
    this.video.currentTime = start;
  }

  private evict(): void {
    const until = this.video.currentTime - KEEP_BEHIND_SECONDS;
    if (until <= 0) return;
    for (const queue of [this.videoOps, this.audioOps]) {
      const buffer = queue?.buffer;
      if (!queue || !buffer || buffer.buffered.length === 0 || buffer.buffered.start(0) >= until) continue;
      // Queued rather than fired at the buffer directly: eviction is triggered by a full buffer
      // in the middle of an append, which is exactly when the buffer is busy.
      void queue.enqueue(() => buffer.remove(0, until)).catch(() => {});
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
   * Points the audio buffer at a different track, in place.
   *
   * Nothing about the video is touched, so the picture never stops. The initialisation segment
   * is what a source buffer decodes by; replacing it and refilling is all a language change is.
   */
  async replaceAudio(mimeType: string | null, init: Uint8Array | null): Promise<void> {
    const queue = this.audioOps;
    if (!queue || !mimeType || !init || this.destroyed) return;
    this.generation += 1;

    if (mimeType !== this.plan.audioMimeType) {
      if (typeof queue.buffer.changeType !== "function") {
        throw new Error("Ce navigateur ne sait pas changer de codec audio en cours de lecture.");
      }
      await queue.enqueue(() => queue.buffer.changeType(mimeType));
    }
    this.plan = { ...this.plan, audioMimeType: mimeType, audioInit: init };

    await this.clear(queue);
    await queue.enqueue(() => queue.buffer.appendBuffer(init as BufferSource));
  }

  /**
   * Runs something with the read loop stopped and no seek able to slip in beside it.
   *
   * Changing audio language is several steps — describe the new track, re-point the buffer,
   * refill — and a seek arriving between any two of them touches the same buffer from the other
   * side. That is the freeze reported after changing language just as a seek was settling.
   */
  async runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(async () => {
      this.generation += 1;
      await this.fillTask?.catch(() => {});
      return action();
    });
    this.pending = task.then(
      () => {},
      () => {}
    );
    return task;
  }

  private async performSeek(requested: number): Promise<void> {
    if (this.destroyed) return;

    // Clamped to the media, as a media element clamps its own currentTime. Without this, asking
    // for a time past the end sends the reader somewhere there is nothing to read, and the
    // recovery machinery then tries again and again to reach a place that does not exist.
    const end = this.plan.durationSeconds > 0 ? this.plan.durationSeconds + this.delaySeconds : Infinity;
    const playerSeconds = Math.min(Math.max(0, requested), Math.max(0, end - 0.25));

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

    // No abort() here any more. Cancelling an operation mid-flight leaves the buffer's parser in
    // a state the next append has to be careful about, and the queue already guarantees that
    // whatever was running has finished before this removal starts.
    for (const queue of [this.videoOps, this.audioOps]) {
      if (queue) await this.clear(queue);
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

  private async clear(queue: BufferQueue): Promise<void> {
    if (queue.buffer.buffered.length === 0 || this.source.readyState !== "open") return;
    // A finite end rather than Infinity: it is what the specification's examples use and what
    // every implementation is exercised against.
    const end = Number.isFinite(this.source.duration) ? this.source.duration + 1 : 1e9;
    await queue.enqueue(() => queue.buffer.remove(0, end)).catch(() => {
      // A removal the browser declines is not worth failing a seek over; the append that follows
      // will overwrite the range anyway.
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
    // A paused element is not stalled, and the frame it is showing is already on screen. Seeking
    // underneath it would move the picture for no reason and land the resume elsewhere.
    if (this.destroyed || this.ended || !this.videoBuffer || this.video.paused) return;

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
    // The count only means anything while the attempts are rapid. The same position failing
    // again a minute later is a fresh problem, not a spin — and treating it as one used to latch
    // the guard shut, so the position stayed unreachable until the viewer seeked elsewhere.
    if (Date.now() - this.lastRecoveryAt > RECOVERY_WINDOW_MS) this.recoveryStreak = 0;
    this.lastRecoveryAt = Date.now();

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
      ...(this.resumeTrace
        ? {
            "Dernière pause": `arrêt ${this.resumeTrace.paused.toFixed(3)} → repos ${this.resumeTrace.settled.toFixed(3)}${
              this.resumeTrace.asserted !== null ? " → recalé" : ""
            }`,
            "Dernière reprise": Number.isNaN(this.resumeTrace.play)
              ? "—"
              : `départ ${this.resumeTrace.play.toFixed(3)} → 1er tick ${this.resumeTrace.tick?.toFixed(3) ?? "—"}`,
          }
        : {}),
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
    this.video.removeEventListener("pause", this.onPause);
    this.video.removeEventListener("play", this.onPlay);
    this.video.removeEventListener("playing", this.request);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.pauseSettleTimer) clearInterval(this.pauseSettleTimer);
    this.pauseSettleTimer = null;
    if (this.pauseAssertTimer) clearTimeout(this.pauseAssertTimer);
    this.pauseAssertTimer = null;

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
