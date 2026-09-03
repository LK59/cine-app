// Feeds remuxed segments to a real <video> element through MediaSource.
//
// This is the path that costs the least and gives the most: the browser decodes in hardware,
// composites the picture itself, drives its own audio clock, and handles HDR natively. Nothing
// here touches a pixel or a sample — it only decides what to hand over and when.
//
// Anything that goes wrong is reported, never worked around silently. A player that quietly falls
// back leaves you unable to tell a path that works from a path that was never used.

import type { Remuxer, RemuxPlan, TrackedCue } from "./remuxer";
import { audioBufferRebuildable } from "./remuxer";
import { trace } from "./trace";

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

/** Past this, a silent picture is better than a still one — and the viewer is told nothing more. */
const AUDIO_HOLD_TIMEOUT_MS = 10000;

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
 * How long the clock is watched after a pause has been flushed, in case the flush did not take.
 *
 * The flush itself is immediate; this only covers a platform that queues more sound after being
 * told to discard what it had. A clock advancing while nothing is playing is exactly that.
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

/**
 * Segments that change nothing before the reading is called pointless.
 *
 * Enough that an ordinary stretch of eviction or an odd boundary is never mistaken for it, few
 * enough that a browser silently dropping everything is caught in a second or two rather than
 * after the whole file has gone past.
 */
const FRUITLESS_APPENDS = 8;

/**
 * How far the clock may creep while paused before it is worth putting back.
 *
 * Below this the correction costs more than the drift: re-stating the position is a seek, and a
 * seek at a pause is heard.
 */
const PAUSE_DRIFT_SECONDS = 0.25;

/**
 * How far past a seek's target the playhead may be moved to reach the media it produced.
 *
 * Generously more than a segment, because a sparse index misses by that much, and far less than
 * any distance a viewer would notice as the wrong place in a film. Beyond it, the gap is a fault
 * worth reporting rather than stepping over.
 */
const SEEK_LANDING_SECONDS = 15;

/** Including the one made at the pause itself. Past this, the element is left alone. */
const MAX_PAUSE_ASSERTIONS = 3;

/** Only the opening handful of segments is recorded: after that the record says nothing new. */
const TRACED_APPENDS = 4;

/** How much already-played media to keep before evicting, so a short step back does not re-fetch. */
const KEEP_BEHIND_SECONDS = 30;

export interface MseCallbacks {
  /** Fatal: playback cannot continue on this path. The caller decides what to say and offer. */
  onError: (message: string) => void;
  /** Subtitle lines found in the stretch of file just read, already timed on the player's clock. */
  onSubtitles?: (cues: TrackedCue[]) => void;
  /** Something was refused but playback continues — a seek the file cannot serve, typically. */
  onWarning?: (message: string) => void;
  /**
   * Play has been pressed and the clock has not moved yet, or null once it has.
   *
   * Reported as a fact rather than as a platform: on iOS the pipeline needs a moment to refill
   * the sound it was told to discard, and on a desktop the same condition clears within a frame.
   * A caller can therefore show that something is happening without ever asking which browser it
   * is in, and without inventing a delay where there is none.
   */
  onStarting?: (startedAt: number | null) => void;
}

type MediaSourceCtor = typeof MediaSource | typeof ManagedMediaSource;

function sourceConstructor(): MediaSourceCtor | null {
  if (typeof window === "undefined") return null;
  // Preferred on iPhone: plain MediaSource is absent there, and the managed one lets the system
  // evict buffered media under pressure instead of the tab being killed.
  return window.ManagedMediaSource ?? (typeof MediaSource !== "undefined" ? MediaSource : null);
}

/** Whether the player will take this codec inside a MediaSource, which is not the same question
 * as whether it can decode the codec at all: Chrome plays AC-3 nowhere, Safari plays it in both. */
export function containerAccepts(mimeType: string): boolean {
  const Source = sourceConstructor();
  if (!Source) return false;
  try {
    return Source.isTypeSupported(mimeType);
  } catch {
    return false;
  }
}

/**
 * Whether this browser will let an audio buffer be taken out and a new one put in its place,
 * mid-playback, without losing the MediaSource.
 *
 * The third of three ways to change what the sound decodes by, and the only one not yet tried.
 * `changeType` is accepted here and then answered with a decode failure that closes the source;
 * rebuilding the whole MediaSource detaches the element, and Safari does not reliably come back.
 * Removing one source buffer and adding another keeps both the element and the picture's buffer.
 *
 * Asked of a throwaway source on a detached element — which never has to be in the document to
 * reach "open" — so the answer costs a few milliseconds once, and no guess is made on behalf of
 * a browser nobody has tested.
 */
let rebuildAnswer: Promise<boolean> | null = null;

/** Candidates for the probe below, in the order they are worth trying. */
const AUDIO_PROBE_TYPES = [
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="ac-3"',
  'audio/mp4; codecs="opus"',
  'audio/mp4; codecs="ec-3"',
];

export function canRebuildAudioBuffer(videoMime: string): Promise<boolean> {
  rebuildAnswer ??= (async () => {
    const Source = sourceConstructor();
    // No document means no element to attach a source to, and a source that never opens cannot
    // answer this. Nothing is guessed on its behalf.
    if (!Source || typeof document === "undefined") return false;

    // Two types this browser actually takes, chosen here rather than named in advance. Asking an
    // iPhone to swap to Opus — which it does not accept in a MediaSource at all — made
    // addSourceBuffer throw over the codec rather than over the swap, and the answer came back
    // "no" to a question that was never put. With fewer than two, no file can change audio codec
    // mid-playback anyway, so there is nothing to refuse.
    const usable = AUDIO_PROBE_TYPES.filter((type) => containerAccepts(type));
    if (usable.length < 2) return true;
    const [first, second] = usable;
    const video = document.createElement("video");
    video.disableRemotePlayback = true;
    const source = new Source();
    try {
      const opened = new Promise<boolean>((resolve) => {
        source.addEventListener("sourceopen", () => resolve(true), { once: true });
        setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      });
      (video as unknown as { srcObject: unknown }).srcObject = source;
      if (!(await opened)) return false;

      // The picture's buffer is there for realism: an implementation may treat the last buffer
      // leaving differently from one of two.
      source.addSourceBuffer(videoMime);
      const audio = source.addSourceBuffer(first);
      source.removeSourceBuffer(audio);
      source.addSourceBuffer(second);
      return true;
    } catch {
      return false;
    } finally {
      try {
        (video as unknown as { srcObject: unknown }).srcObject = null;
      } catch {
        /* nothing left to detach */
      }
    }
  })();
  return rebuildAnswer;
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

/** How far before the end of the held picture the reader starts building segments in full again. */
const VIDEO_SKIP_MARGIN = 6;

/** A source that has not opened by now is not going to answer the rebuild question either. */
const PROBE_TIMEOUT_MS = 300;

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

  /**
   * @param why Whatever the element and the source can say about a refusal. The `error` event
   * carries no detail of its own, so without this the one failure that stops playback on iOS
   * arrives as a sentence with nothing in it.
   */
  constructor(
    readonly buffer: SourceBuffer,
    private readonly why: () => string = () => ""
  ) {}

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
      const onFail = () => finish(new Error(`Le navigateur a refusé une opération sur le tampon. ${this.why()}`));
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
  /** Set while the picture is deliberately held still for want of sound. See beginAudioHold. */
  private audioHold: { wanted: boolean; engaged: boolean } | null = null;
  /** Answered by the probe above, before the file was opened. */
  rebuildAudioAllowed = false;
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
  /** While set, video already held is not sent again — see refillAudio. */
  private skipVideoUntil: number | null = null;
  private lastAppendAt = 0;
  /** How far the reader has read, on the player's clock. See the video-skip margin. */
  private readUpTo = 0;
  /** Where a seek was served, until the playhead is actually standing on media. */
  private seekLanding: number | null = null;
  /** Where the picture froze when the viewer pressed pause. Resume lands exactly there. */
  private pauseAnchor: number | null = null;
  private resumeDeadline = 0;
  private resumeStartedAt = 0;
  private pauseStartedAt = 0;
  /**
   * Where the clock was when play was asked for, while it has not moved since.
   *
   * Kept apart from the pause trace on purpose: that trace only exists once something has been
   * paused, and the very first play — the automatic one, before anyone has touched anything —
   * would otherwise raise this and have nothing able to lower it again.
   */
  private startingFrom: number | null = null;
  private frameCallback: number | null = null;
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
    asserted: number;
    play: number;
    tick: number | null;
    /** Milliseconds between pressing play and the clock actually moving. */
    latencyMs: number | null;
    /**
     * How long the pause lasted, which is the question that discriminates.
     *
     * If emptying the queue is what costs, then time spent paused is time the platform has
     * already had to recover, and a long pause should start faster than a short one. If the cost
     * is charged at the press regardless, it does not depend on this at all.
     */
    pausedForMs: number | null;
  } | null = null;

  /** Re-states the position, which runs the seek algorithm and so discards any queued sound. */
  private assertPausePosition(): void {
    const anchor = this.pauseAnchor;
    if (this.destroyed || anchor === null || !this.video.paused) return;
    this.lastSeekTarget = anchor;
    this.video.currentTime = anchor;
    if (this.resumeTrace) this.resumeTrace.asserted += 1;
  }

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
    instance.rebuildAudioAllowed = audioBufferRebuildable();
    await instance.open(startSeconds);
    return instance;
  }

  /** Where the player's clock sits relative to the file's. Already applied to every seek here. */
  get presentationDelay(): number {
    return this.delaySeconds;
  }

  private appendsTraced = 0;

  private async open(startSeconds: number): Promise<void> {
    // AirPlay cannot carry a managed stream, and Safari refuses to attach one until this is set.
    this.video.disableRemotePlayback = true;

    trace("attente de sourceopen");
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

    trace("MediaSource ouverte, création des tampons");
    this.videoBuffer = this.source.addSourceBuffer(this.plan.videoMimeType);
    this.videoBuffer.mode = "segments";
    this.videoOps = new BufferQueue(this.videoBuffer, () => this.elementState());
    if (this.plan.audioMimeType) {
      this.audioBuffer = this.source.addSourceBuffer(this.plan.audioMimeType);
      this.audioBuffer.mode = "segments";
      this.audioOps = new BufferQueue(this.audioBuffer, () => this.elementState());
    }

    await this.appendTo(this.videoOps, this.plan.videoInit, this.generation);
    trace("segment d'initialisation vidéo accepté");
    if (this.audioOps && this.plan.audioInit) {
      await this.appendTo(this.audioOps, this.plan.audioInit, this.generation);
      trace("segment d'initialisation audio accepté");
    }

    // Positioned before the first read, not after it. Filling thirty seconds from the beginning
    // and then throwing all of it away is what made resuming a part-watched episode feel slow.
    if (startSeconds > 1 && this.remuxer.seekable) {
      this.remuxer.seekTo(startSeconds);
      this.lastSeekTarget = startSeconds;
      this.video.currentTime = startSeconds;
    }

    // The element's own verdict, recorded when it is delivered. Everything so far learned of it
    // second-hand, when some later operation tripped over the wreckage — so the report showed the
    // consequence and never the moment.
    this.video.addEventListener("error", this.onElementError);
    this.source.addEventListener("sourceclose", this.onSourceClosed);

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

    // Started, not waited for. Filling runs until there is a comfortable amount of media, and
    // waiting for that before declaring the player ready makes the whole session hostage to it:
    // a browser that accepts segments and keeps nothing from them leaves the depth at zero, the
    // loop reading the film from end to end, and the viewer looking at a spinner that has no
    // reason to ever stop. The element reports its own readiness, and the controls show the wait.
    void this.fill();
  }

  private readonly request = () => {
    // The first tick after resuming is where a jump would show, so it is recorded before
    // anything here has a chance to act on it.
    // Independent of the pause trace, so the first automatic play is answered too.
    if (this.startingFrom !== null && this.video.currentTime > this.startingFrom + 0.01) {
      this.startingFrom = null;
      this.stopWatchingForFirstFrame();
      this.callbacks.onStarting?.(null);
    }

    const trace = this.resumeTrace;
    if (trace && !Number.isNaN(trace.play)) {
      if (trace.tick === null) trace.tick = this.video.currentTime;
      // Not the first event after play, but the first one where the clock has actually moved:
      // that is when sound and picture are genuinely running again, and it is what a viewer
      // feels as the button being slow.
      if (trace.latencyMs === null && this.video.currentTime > trace.play + 0.01) {
        trace.latencyMs = Date.now() - this.resumeStartedAt;
        trace.pausedForMs = this.resumeStartedAt - this.pauseStartedAt;
      }
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
    this.startingFrom = null;
    this.stopWatchingForFirstFrame();
    this.callbacks.onStarting?.(null);
    this.pauseAnchor = this.video.currentTime;
    this.resumeTrace = {
      paused: this.pauseAnchor,
      settled: this.pauseAnchor,
      asserted: 0,
      play: NaN,
      tick: null,
      latencyMs: null,
      pausedForMs: null,
    };
    this.pauseStartedAt = Date.now();

    // Emptied at once, not a second later.
    //
    // The half second that turns up at the instant of resuming is the sound iOS still holds
    // queued: it plays on past the frozen picture, and the clock — which follows the sound —
    // reports it all in one go when playback restarts. Asking the element to be where it already
    // is runs the seek algorithm, and that discards what is queued. Doing it immediately means
    // there is never anything queued to drain, so a resume a fraction of a second later is as
    // exact as one a minute later. Waiting first, as this did, left the fast pause-and-play
    // untouched — the very case where the wait is most obvious.
    this.assertPausePosition();

    // Then watched, in case the flush did not take on the first attempt: the clock advancing
    // while nothing is playing is the queue draining anyway, and it is re-stated each time.
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
      // Each assertion runs the seek algorithm, and on iOS that re-renders the sound around the
      // position — audible, as a tenth of a second replayed. Once was the fix; every eighty
      // milliseconds for as long as the clock keeps creeping is a stuck record. So: only a drift
      // large enough to be worth correcting, and only a couple of times before this leaves the
      // element alone with whatever it has settled on.
      if (settled !== null && this.video.currentTime > settled + PAUSE_DRIFT_SECONDS) {
        this.pauseAnchor = this.video.currentTime;
        if (this.resumeTrace) this.resumeTrace.settled = this.video.currentTime;
        this.assertPausePosition();
        if ((this.resumeTrace?.asserted ?? 0) >= MAX_PAUSE_ASSERTIONS) {
          clearInterval(this.pauseSettleTimer!);
          this.pauseSettleTimer = null;
        }
      }
    }, 120);

  };

  private readonly onElementError = () => {
    trace(`l'élément a échoué : ${this.elementState()}`);
  };

  private readonly onSourceClosed = () => {
    trace(`la MediaSource s'est fermée — ${this.elementState()}`);
  };

  private readonly onPlay = () => {
    if (this.destroyed) return;
    // Held for a moment rather than settled on the spot: the element fires this as soon as play
    // is called, which is before it has actually resumed and therefore before it can have
    // jumped. Checked again as playback gets going, until the window closes.
    this.resumeStartedAt = Date.now();
    if (this.resumeTrace) this.resumeTrace.play = this.video.currentTime;
    this.startingFrom = this.video.currentTime;
    this.callbacks.onStarting?.(this.resumeStartedAt);
    this.watchForFirstFrame(this.startingFrom);
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

  /**
   * Playback has genuinely begun.
   *
   * Waiting instead for the clock to be seen moving means waiting for the next timeupdate, which
   * a browser emits about four times a second — long enough for the picture to be running again
   * before anyone here notices, and for a spinner to appear over media that is already playing
   * and then vanish. This event is the moment itself.
   */
  /**
   * Waits for a picture to actually be presented, and only then stops saying it is starting.
   *
   * The three candidate signals are not interchangeable. The playing event fires as soon as play
   * is called, before the pipeline has begun — clearing on it means never showing anything at
   * all. timeupdate arrives about four times a second, so the picture can be running again a
   * fifth of a second before anyone here notices, which is long enough to show a spinner over
   * media that is already moving and then take it away. This one is the frame itself.
   */
  private watchForFirstFrame(from: number): void {
    const request = this.video.requestVideoFrameCallback?.bind(this.video);
    if (!request) return; // fallback: the clock check below, a beat late but correct

    const step = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      this.frameCallback = null;
      if (this.destroyed || this.startingFrom === null) return;
      if (metadata.mediaTime > from + 0.01) {
        this.startingFrom = null;
        this.callbacks.onStarting?.(null);
        return;
      }
      this.frameCallback = request(step);
    };
    this.frameCallback = request(step);
  }

  private stopWatchingForFirstFrame(): void {
    if (this.frameCallback === null) return;
    this.video.cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = null;
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
  /** How far the picture is held from the playhead, ignoring what the sound is doing. */
  private videoBufferedEnd(): number {
    const ranges = this.videoBuffer?.buffered;
    const now = this.video.currentTime;
    for (let i = 0; ranges && i < ranges.length; i++) {
      if (ranges.start(i) <= now + 0.1 && now < ranges.end(i)) return ranges.end(i);
    }
    return now;
  }

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
    // Media accepted but not retained leaves the depth where it was. A handful of segments that
    // change nothing is a browser quietly discarding what it is given, and reading the rest of
    // the film to find that out is the worst possible answer.
    let deepestSoFar = this.bufferedEnd();
    let fruitless = 0;

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

        // Nothing asks for the pictures of a stretch the browser already holds — which is every
        // language change. The file still has to be read for them (Matroska interleaves the sound
        // with them), but copying megabytes into segments that are then dropped does not. The
        // margin means the segment that crosses back over the line is built in full.
        this.remuxer.setVideoWanted(this.skipVideoUntil === null || this.readUpTo >= this.skipVideoUntil - VIDEO_SKIP_MARGIN);

        const segment = await this.remuxer.nextSegment();
        if (this.generation !== generation || this.destroyed) break;
        if (this.appendsTraced < TRACED_APPENDS) {
          this.appendsTraced++;
          trace(
            segment
              ? `segment ${this.appendsTraced} construit — jusqu'à ${segment.endSeconds.toFixed(1)} s, ` +
                  `${segment.video?.byteLength ?? 0} o vidéo, ${segment.audio?.byteLength ?? 0} o audio`
              : "le remultiplexeur ne produit plus de segment (fin du fichier)"
          );
        }

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

        // Video the browser already holds is not sent again. Re-appending over media that has
        // been played is what it catches up on at speed — the burst of fast-forward reported
        // after changing audio language, and before that after choosing a subtitle.
        if (this.skipVideoUntil !== null && segment.endSeconds > this.skipVideoUntil) {
          this.skipVideoUntil = null;
        }
        const sendVideo = this.skipVideoUntil === null;
        if (segment.video && this.videoOps && sendVideo) {
          await this.appendTo(this.videoOps, segment.video, generation);
        }
        if (segment.audio && this.audioOps) await this.appendTo(this.audioOps, segment.audio, generation);
        // A seek arrived while those were in flight: this loop's appends were discarded, so its
        // reading of where the media is would be about a position no longer being served.
        if (this.generation !== generation || this.destroyed) break;

        this.readUpTo = segment.endSeconds;
        this.nudgeIntoBuffer();
        this.lastAppendAt = Date.now();

        const depth = this.bufferedEnd();
        if (this.appendsTraced <= TRACED_APPENDS && this.appendsTraced > 0) {
          trace(`après envoi : tampon jusqu'à ${depth.toFixed(1)} s, tête à ${this.video.currentTime.toFixed(1)} s`);
        }
        if (depth > deepestSoFar + 0.01) {
          deepestSoFar = depth;
          fruitless = 0;
        } else if (++fruitless >= FRUITLESS_APPENDS) {
          throw new Error(
            `Le navigateur n'a rien retenu des ${FRUITLESS_APPENDS} segments qui lui ont été envoyés. ${this.elementState()}`
          );
        }

        // The reader is filling a place the viewer is not. Something failed to tell us they
        // moved — an event that did not fire, a seek that did not reach here — and the reader
        // would otherwise read its way there one segment at a time, which is exactly what a
        // seek looks like when it appears to recalculate the whole film. The watchdog cannot
        // catch this on its own: media *is* arriving, just nowhere useful.
        // An empty buffer is not a misplaced reader.
        //
        // `distanceToMedia` answers Infinity when nothing is buffered, and nothing is buffered
        // for a moment after every seek and every audio refill — the element's ranges are the
        // *intersection* of the two buffers, so emptying the audio one empties them entirely.
        // Read as a distance, that is "infinitely far from the media", and this fired a recovery
        // at the exact moment the loop was already fetching what was missing. Each recovery is a
        // fresh seek, which empties the buffers again, which fires another: three recoveries in
        // nine seconds, and Safari closes the source. Only media that exists and is genuinely
        // far away means the reader is in the wrong place.
        const distance = this.distanceToMedia(this.video.currentTime);
        if (Number.isFinite(distance) && distance > MISPLACED_SECONDS) {
          trace(
            `reprise : média à ${distance.toFixed(1)} s de la tête (${this.video.currentTime.toFixed(1)} s), ` +
              `lecteur à ${this.readUpTo.toFixed(1)} s`
          );
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
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.callbacks.onError(`${detail} ${this.elementState()}`);
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
    // A seek just served is the one time this may move a stopped picture: the viewer asked to be
    // somewhere, and landing them on nothing is worse than landing them a little further on.
    //
    // "Just served" has to mean exactly that. A flag set at the seek and cleared only on arrival
    // stayed up for the rest of the session whenever playback found its own media, and then a
    // pause half an hour later was free to step fifteen seconds — which is what it did. So the
    // window is the playhead still standing precisely where the seek put it: the moment it moves
    // at all, it is on media and the landing is over.
    const landing = this.seekLanding !== null && Math.abs(this.video.currentTime - this.seekLanding) < 0.05;
    // Otherwise never while paused. The frame on screen is already drawn and needs nothing;
    // moving the playhead under a viewer who has stopped is a picture that jumps on its own, and
    // then resumes somewhere other than where they left it.
    if (ranges.length === 0 || this.destroyed || (this.video.paused && !landing)) return;

    const now = this.video.currentTime;
    let start: number | null = null;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= now && now < ranges.end(i)) {
        this.seekLanding = null; // arrived
        return;
      }
      if (ranges.start(i) > now && (start === null || ranges.start(i) < start)) start = ranges.start(i);
    }
    if (start === null) return;

    // Two tolerances, because two different things are being closed.
    //
    // In the ordinary case, only a gap the size of the presentation delay: anything larger is a
    // real hole in the stream, and stepping over it silently would hide a genuine fault.
    //
    // Right after a seek it is far wider, and that is the whole point. An index is not exact:
    // asking this file for 1568 s produced media that begins at 1570.6, and no amount of waiting
    // or seeking again will ever make it cover 1568 — the recovery asked three times, each time
    // was served, and each time the playhead stayed on nothing until the reader gave up and
    // declared the browser to be keeping nothing. A media element seeking into a gap lands on
    // the nearest media it has; so does this.
    const tolerance = landing ? SEEK_LANDING_SECONDS : this.delaySeconds + 0.15;
    if (start - now > tolerance) return;
    if (landing) trace(`atterrissage : la tête passe de ${now.toFixed(1)} s au média qui commence à ${start.toFixed(1)} s`);
    this.seekLanding = null;

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
  seek(playerSeconds: number, because = "le viseur"): Promise<void> {
    trace(`saut demandé vers ${playerSeconds.toFixed(1)} s (${because}) — tête à ${this.video.currentTime.toFixed(1)} s`);
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
        if (this.destroyed) return;
        // Given the same second chance as a refused append, and for the same reason: a seek that
        // lands on a buffer operation the browser declines has lost nothing that cannot be read
        // again. Declaring playback over on the first one is what turned "one seek too many"
        // into a dead player.
        this.appendFailures += 1;
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (this.appendFailures <= MAX_APPEND_FAILURES && this.recover(this.video.currentTime)) {
          this.callbacks.onWarning?.("Reprise après un saut refusé.");
          return;
        }
        this.callbacks.onError(`${detail} ${this.elementState()}`);
      });
    return this.pending;
  }

  /**
   * Keeps the picture from running on without sound — but only if it actually would.
   *
   * A media element is supposed to stall when a buffer has nothing at the playhead. Chrome does;
   * Safari plays the picture on in silence, and a couple of seconds of film go by unheard while a
   * newly chosen track is still being decoded. Stopping the element up front fixed that and cost
   * something else: on Chrome, where nothing was wrong, every change of track came with a visible
   * pause. So nothing is done until the thing being prevented is actually happening — the picture
   * moving with no sound under it — and on a browser that stalls by itself, nothing is done at all.
   */
  beginAudioHold(): void {
    if (this.destroyed || this.audioHold) return;
    this.audioHold = { wanted: false, engaged: false };
    this.video.addEventListener("play", this.onPlayDuringHold);
    void this.guardAgainstSilentPicture();
  }

  private readonly onPlayDuringHold = () => {
    // A press of play into a gap is remembered rather than obeyed.
    if (this.audioHold && !this.audioCovers(this.video.currentTime)) this.engageHold();
  };

  private engageHold(): void {
    const hold = this.audioHold;
    if (!hold || this.destroyed) return;
    hold.wanted = true;
    if (!hold.engaged) {
      hold.engaged = true;
      // The same signal the opening wait uses, so the viewer gets the spinner they already know.
      this.callbacks.onStarting?.(Date.now());
    }
    this.video.pause();
  }

  /** Whether the sound covers a point on the player's clock. */
  private audioCovers(seconds: number): boolean {
    const ranges = this.audioBuffer?.buffered;
    for (let i = 0; ranges && i < ranges.length; i++) {
      if (ranges.start(i) <= seconds + 0.05 && seconds < ranges.end(i)) return true;
    }
    return false;
  }

  /** Runs for as long as the hold lasts, and only ever stops the picture — never starts it. */
  private async guardAgainstSilentPicture(): Promise<void> {
    while (this.audioHold && !this.destroyed) {
      if (!this.video.paused && !this.audioCovers(this.video.currentTime)) this.engageHold();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  /**
   * Ends the hold once there is sound at the playhead — or once waiting for it has gone on long
   * enough that a silent picture is better than a still one.
   */
  private async releaseWhenAudioArrives(): Promise<void> {
    const deadline = Date.now() + AUDIO_HOLD_TIMEOUT_MS;
    while (this.audioHold && !this.destroyed && Date.now() < deadline) {
      if (this.audioCovers(this.video.currentTime)) break;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    this.endAudioHold();
  }

  private endAudioHold(): void {
    const hold = this.audioHold;
    if (!hold) return;
    this.audioHold = null;
    this.video.removeEventListener("play", this.onPlayDuringHold);
    if (hold.engaged) this.callbacks.onStarting?.(null);
    if (hold.wanted && !this.destroyed) void this.video.play().catch(() => {});
  }

  /**
   * Starts watching for the sound to come back, so the picture can move again.
   *
   * Called once whatever is going to produce that sound has been set going — never before, or it
   * would find the *old* track still covering the playhead and let go immediately.
   */
  armAudioRelease(): Promise<void> {
    return this.releaseWhenAudioArrives();
  }

  /** Lets the picture go again — for a caller whose change of track came to nothing. */
  releaseAudioHold(): void {
    this.endAudioHold();
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

    // A different codec is not something to ask a buffer to absorb. Where the browser allows it,
    // the buffer is replaced rather than reinterpreted: the MediaSource, the element and the
    // picture's own buffer are all left standing, and only the sound is rebuilt from nothing.
    if (mimeType !== this.plan.audioMimeType && this.rebuildAudioAllowed) {
      await this.rebuildAudioBuffer(mimeType, init);
      return;
    }

    // Emptied before the codec changes, not after. Asking a buffer to reinterpret itself while
    // it still holds coded frames of the codec it is leaving is more than the specification
    // requires of an implementation, and Safari answered it with a decode failure — which closes
    // the MediaSource and takes the picture with it.
    await this.clear(queue);

    if (mimeType !== this.plan.audioMimeType) {
      if (typeof queue.buffer.changeType !== "function") {
        throw new Error("Ce navigateur ne sait pas changer de codec audio en cours de lecture.");
      }
      await queue.enqueue(() => queue.buffer.changeType(mimeType));
    }
    this.plan = { ...this.plan, audioMimeType: mimeType, audioInit: init };

    await queue.enqueue(() => queue.buffer.appendBuffer(init as BufferSource));
  }

  /**
   * Takes the audio buffer out and puts a new one in its place.
   *
   * Everything the viewer can see survives it: the MediaSource stays open, the element stays
   * attached, and the picture's buffer keeps every frame it holds. Only the sound starts again
   * from nothing — which is what a change of codec is.
   */
  private async rebuildAudioBuffer(mimeType: string, init: Uint8Array): Promise<void> {
    const outgoing = this.audioBuffer;
    // Nothing in flight: removing a buffer mid-operation is the one way to make this worse.
    await this.audioOps?.enqueue(() => {}).catch(() => {});
    if (this.destroyed || this.source.readyState !== "open") {
      throw new Error(`La source ne peut plus recevoir de piste audio. ${this.elementState()}`);
    }

    if (outgoing) this.source.removeSourceBuffer(outgoing);
    trace(`piste audio : tampon reconstruit en ${mimeType}`);
    this.audioBuffer = this.source.addSourceBuffer(mimeType);
    this.audioBuffer.mode = "segments";
    this.audioOps = new BufferQueue(this.audioBuffer, () => this.elementState());
    this.plan = { ...this.plan, audioMimeType: mimeType, audioInit: init };
    await this.appendTo(this.audioOps, init, this.generation);
  }

  /**
   * Replaces the sound from a point on the player's clock, leaving the picture alone.
   *
   * A change of audio language needs the sound re-read, and nothing else. Doing it with an
   * ordinary seek clears the video too and sends it again over media the browser has already
   * played — which it then catches up on at speed, replaying several seconds in one or two.
   * Here the video buffer is untouched and the segments that would overlap it are not sent.
   */
  async refillAudio(playerSeconds: number): Promise<void> {
    if (this.destroyed || !this.audioOps) return;
    this.generation += 1;
    await this.fillTask?.catch(() => {});

    // Measured on the video buffer alone, and this matters: `bufferedEnd` reads the element's
    // ranges, which are the *intersection* of the two buffers — and the audio one was just
    // emptied by the codec change, so the intersection at the playhead is nothing at all. Read
    // that way, this said "we hold no video", and the reader appended the picture again from the
    // keyframe before the playhead: replacing, under a decoder mid-frame, the very samples it
    // was working on. The sound carried on from its own fresh buffer while the picture stopped,
    // and a seek — which re-primes the decoder — showed the right frame again.
    this.skipVideoUntil = this.videoBufferedEnd();
    this.readUpTo = playerSeconds;
    await this.clear(this.audioOps);
    this.remuxer.seekTo(Math.max(0, playerSeconds - this.delaySeconds));
    void this.fill();
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
    // An ordinary seek replaces everything, so nothing is being spared.
    this.skipVideoUntil = null;
    this.readUpTo = playerSeconds;
    this.seekLanding = playerSeconds;
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
    trace(
      `reprise : rien sous la tête à ${now.toFixed(1)} s, ` +
        `dernier envoi il y a ${Date.now() - this.lastAppendAt} ms, ${this.elementState()}`
    );
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
    void this.seek(target, `reprise ${this.recoveryStreak}`);
    return true;
  }

  /** What the technical panel shows. Enough to tell a stall apart from a refusal to fetch. */
  /**
   * What the element and the source have to say — the two things that know why an append was
   * refused, when the event itself carries nothing.
   */
  private elementState(): string {
    const parts = [`MediaSource ${this.source.readyState}`];
    const failure = this.video.error;
    if (failure) parts.push(`élément code ${failure.code}${failure.message ? ` « ${failure.message} »` : ""}`);
    parts.push(`readyState ${this.video.readyState}`, `réseau ${this.video.networkState}`);
    return `(${parts.join(", ")})`;
  }

  /**
   * Whether the platform has taken the source away.
   *
   * iOS reclaims media resources when a page goes to the background, and a MediaSource it has
   * closed cannot be reopened — every buffer on it is gone with it. There is nothing to repair
   * here; the caller has to build the whole thing again.
   */
  get lost(): boolean {
    return !this.destroyed && this.source.readyState === "closed";
  }

  /** Where the viewer was, for a caller that has to rebuild and wants to come back to it. */
  get position(): number {
    return this.video.currentTime;
  }

  get debug(): Record<string, string> {
    // Reading a buffer whose source has closed throws, and the whole panel used to come back as
    // one "invalid state" line — at exactly the moment there was most to learn from it.
    const spans: string[] = [];
    try {
      const ranges = this.videoBuffer?.buffered;
      for (let i = 0; ranges && i < ranges.length; i++) {
        spans.push(`${ranges.start(i).toFixed(0)}–${ranges.end(i).toFixed(0)}`);
      }
    } catch {
      spans.push("illisible (source fermée)");
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
              this.resumeTrace.asserted > 0 ? ` → recalé ×${this.resumeTrace.asserted}` : ""
            }`,
            "Dernière reprise": Number.isNaN(this.resumeTrace.play)
              ? "—"
              : `départ ${this.resumeTrace.play.toFixed(3)} → 1er tick ${this.resumeTrace.tick?.toFixed(3) ?? "—"}`,
            "Délai du bouton lecture":
              this.resumeTrace.latencyMs === null
                ? "—"
                : `${this.resumeTrace.latencyMs} ms · après ${((this.resumeTrace.pausedForMs ?? 0) / 1000).toFixed(1)} s de pause`,
          }
        : {}),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.startingFrom = null;
    this.stopWatchingForFirstFrame();
    this.callbacks.onStarting?.(null);
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
    this.video.removeEventListener("play", this.onPlayDuringHold);
    this.video.removeEventListener("error", this.onElementError);
    this.source.removeEventListener("sourceclose", this.onSourceClosed);
    this.audioHold = null;

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
