// Everything about the element's own clock.
//
// Pausing, resuming, landing on media after a seek, and holding a picture that would otherwise
// run on without sound. None of it is about buffers or bytes: it is about what the viewer sees
// and hears at the moment they press something, and almost all of it exists because a device
// disagreed with the specification about what should happen next.
//
// It lives apart from the source because it is a different subject with a different kind of
// evidence behind it — every rule here was measured on a device, and the comments say which.

import { trace } from "./trace";

/**
 * What the guard needs from the source it belongs to.
 *
 * Deliberately small, and all of it read-only except the two verbs: this half decides *when* the
 * playhead should move, and the source remains the only thing that moves media.
 */
export interface GuardHost {
  readonly destroyed: boolean;
  /** How far the player's clock runs ahead of the file's. */
  readonly delaySeconds: number;
  /** What the element can actually play: the intersection of its buffers. */
  readonly playable: TimeRanges;
  /** The sound's own ranges, which is a different question — see the silent-picture guard. */
  readonly audioRanges: TimeRanges | null;
  seek(seconds: number, because: string): Promise<void>;
  /** Tells the source a position was moved to deliberately, so it does not read it as a jump. */
  noteSeekTarget(seconds: number): void;
}

/** Past this, a silent picture is better than a still one — and the viewer is told nothing more. */
const AUDIO_HOLD_TIMEOUT_MS = 10000;

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

/** How many times a start the element abandoned is attempted again before leaving it be. */
const MAX_START_RETRIES = 2;

export class PlaybackGuard {
  constructor(
    private readonly video: HTMLVideoElement,
    private readonly host: GuardHost,
    private readonly onStarting: ((startedAt: number | null) => void) | undefined
  ) {}

  /** Whether a set of ranges covers a point. */
  private covers(ranges: TimeRanges, seconds: number): boolean {
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= seconds && seconds < ranges.end(i)) return true;
    }
    return false;
  }

  /** Set while the picture is deliberately held still for want of sound. See beginAudioHold. */
  private audioHold: { wanted: boolean; engaged: boolean } | null = null;

  /** Where a seek was served, until the playhead is actually standing on media. */
  private seekLanding: number | null = null;
  /** Set when the element abandoned a start rather than the viewer pausing one. */
  private startAborted = false;
  private startRetries = 0;

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
    if (this.host.destroyed || anchor === null || !this.video.paused) return;
    this.host.noteSeekTarget(anchor);
    this.video.currentTime = anchor;
    if (this.resumeTrace) this.resumeTrace.asserted += 1;
  }

  /**
   * The wait shown to the viewer, armed and cleared in one place.
   *
   * Six call sites used to set this directly, and a spinner that stayed up said nothing about
   * which of them had armed it or which had failed to come. Named here, and written to the
   * record, so the next report answers that instead of posing it.
   */
  private setStarting(startedAt: number | null, because: string): void {
    // A clear is never skipped, however sure this is that the wait is already down: being sure
    // and being wrong is the whole shape of the fault. Only a repeated *arming* is dropped, so
    // the record does not fill with the same line.
    if (startedAt !== null && this.startingWait !== null) return;
    this.startingWait = startedAt;
    trace(startedAt === null ? `attente levée (${because})` : `attente affichée (${because})`);
    this.onStarting?.(startedAt);
  }

  private startingWait: number | null = null;

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
    if (anchor === null || this.host.destroyed) return false;
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
    if (this.covers(this.host.playable, anchor)) {
      this.host.noteSeekTarget(anchor);
      this.video.currentTime = anchor;
      return true;
    }
    // The media that was there is gone. Fetching it again is the whole point — this is the case
    // the guard exists for, and the one where giving up leaves the jump in place.
    void this.host.seek(anchor, "reprise après une pause");
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
      if (this.host.destroyed || this.startingFrom === null) return;
      if (metadata.mediaTime > from + 0.01) {
        this.startingFrom = null;
        this.setStarting(null, "première image affichée");
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

  /**
   * Moves the playhead onto the media, when it has landed just short of it.
   *
   * A seek starts reading at the indexed cluster at or before the requested time, but everything
   * this path produces is shifted later by the presentation delay. Land on an index point exactly
   * and the media therefore begins a fifth of a second *after* the playhead — a gap the element
   * will sit in front of indefinitely, waiting for data that is never coming. The step is far too
   * small to see, and it is the difference between a seek that works and one that hangs.
   */
  nudgeIntoBuffer(): void {
    const ranges = this.host.playable;
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
    if (ranges.length === 0 || this.host.destroyed || (this.video.paused && !landing)) return;

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
    const tolerance = landing ? SEEK_LANDING_SECONDS : this.host.delaySeconds + 0.15;
    if (start - now > tolerance) return;
    if (landing) trace(`atterrissage : la tête passe de ${now.toFixed(1)} s au média qui commence à ${start.toFixed(1)} s`);
    this.seekLanding = null;

    this.host.noteSeekTarget(start);
    // A move made on purpose, and the resume guard must not mistake it for one. Left standing,
    // the anchor makes the next event read this step forward as a jump and pull it back — a
    // frame from further on, briefly, then the right one. Settling the position here is what the
    // anchor was for, so it has done its job.
    this.pauseAnchor = null;
    this.video.currentTime = start;
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
    if (this.host.destroyed || this.audioHold) return;
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
    if (!hold || this.host.destroyed) return;
    hold.wanted = true;
    if (!hold.engaged) {
      hold.engaged = true;
      // The same signal the opening wait uses, so the viewer gets the spinner they already know.
      this.setStarting(Date.now(), "image retenue faute de son");
    }
    this.video.pause();
  }

  /** Whether the sound covers a point on the player's clock. */
  private audioCovers(seconds: number): boolean {
    const ranges = this.host.audioRanges;
    for (let i = 0; ranges && i < ranges.length; i++) {
      if (ranges.start(i) <= seconds + 0.05 && seconds < ranges.end(i)) return true;
    }
    return false;
  }

  /** Runs for as long as the hold lasts, and only ever stops the picture — never starts it. */
  private async guardAgainstSilentPicture(): Promise<void> {
    while (this.audioHold && !this.host.destroyed) {
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
    while (this.audioHold && !this.host.destroyed && Date.now() < deadline) {
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
    if (hold.engaged) this.setStarting(null, "le son est revenu");
    if (hold.wanted && !this.host.destroyed) void this.video.play().catch(() => {});
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

  readonly clockTicked = () => {
    // The first tick after resuming is where a jump would show, so it is recorded before
    // anything here has a chance to act on it.
    // Independent of the pause trace, so the first automatic play is answered too.
    if (this.startingFrom !== null && this.video.currentTime > this.startingFrom + 0.01) {
      this.startingFrom = null;
      this.stopWatchingForFirstFrame();
      this.setStarting(null, "l'horloge a avancé");
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
  };

  /**
   * Remembers exactly where the picture stopped.
   *
   * The element's clock does not necessarily stop where the button was pressed: the audio the
   * system has already handed to the hardware plays out over the next fraction of a second, and
   * the clock follows the sound. Resuming then starts from wherever it drifted to, which reads
   * as the film having quietly continued while paused and jumping to catch up.
   */
  readonly paused = () => {
    if (this.host.destroyed) return;
    // A pause that arrives before the first frame of a playback that was asked for is not the
    // viewer pausing — it is the element giving up on a start it could not make.
    if (this.startingFrom !== null) this.startAborted = true;
    this.startingFrom = null;
    this.stopWatchingForFirstFrame();
    this.setStarting(null, "mise en pause");
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
      const stop = this.host.destroyed || this.pauseAnchor === null || !this.video.paused || Date.now() > deadline;
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

  readonly playing = () => {
    if (this.host.destroyed) return;
    // Held for a moment rather than settled on the spot: the element fires this as soon as play
    // is called, which is before it has actually resumed and therefore before it can have
    // jumped. Checked again as playback gets going, until the window closes.
    this.resumeStartedAt = Date.now();
    if (this.resumeTrace) this.resumeTrace.play = this.video.currentTime;
    this.startingFrom = this.video.currentTime;
    this.setStarting(this.resumeStartedAt, "lecture demandée");
    this.watchForFirstFrame(this.startingFrom);
    this.resumeDeadline = this.resumeStartedAt + RESUME_GUARD_MS;
    const moved = this.holdPausePosition();

    // Nothing moves the playhead while paused, so any settling owed is settled here — before the
    // watchdog's own delay, which would otherwise be a visible wait at the moment of pressing
    // play. Skipped when the position was just put back, which has already settled it.
    if (!moved) this.nudgeIntoBuffer();
  };

  /** A seek has been served: the landing licence lasts only while the playhead has not moved. */
  seekServed(playerSeconds: number): void {
    this.seekLanding = playerSeconds;
  }

  /**
   * The film has just been opened at this position.
   *
   * Treated as a landing, because that is what it is: a request to be somewhere, about to be
   * answered with media that begins a fraction of a second later. Without the licence the
   * opening deadlocks — the element is paused because there is nothing under the playhead, and
   * the playhead is not moved onto the media because the element is paused.
   */
  opened(playerSeconds: number): void {
    this.seekLanding = playerSeconds;
    this.startAborted = false;
    this.startRetries = 0;
  }

  /**
   * The first media has arrived. Starts the film if it was asked for and never began.
   *
   * Measured on an iPhone, opening an episode from the beginning: the media of a file with
   * B-frames starts 210 ms in, `play()` was called before any of it existed, and the element
   * aborted the attempt and went back to paused with the playhead short of everything. The film
   * then sat at 0:00 with thirty seconds buffered, and only a seek or a press of play — both of
   * which the viewer had to think of — got it going.
   *
   * Only for a start the *element* abandoned: a viewer who pressed pause while it was loading
   * has asked for exactly this, and starting the film under them would be the player arguing.
   */
  mediaArrived(): void {
    if (this.host.destroyed || !this.startAborted) return;
    if (this.startRetries >= MAX_START_RETRIES) return;
    this.startRetries += 1;
    this.startAborted = false;

    // Onto the media first: playing from a position that has nothing under it is what failed the
    // first time. The licence is re-granted here rather than relied on — the failed start ran a
    // nudge of its own, and a nudge that reaches its media spends the licence on the way.
    this.seekLanding = this.video.currentTime;
    this.nudgeIntoBuffer();
    trace(`démarrage repris (${this.startRetries}) — tête à ${this.video.currentTime.toFixed(2)} s`);
    void this.video.play().catch(() => {
      // Nothing more to do: the controls are showing a play button, which is now the only thing
      // that can carry the permission this needs.
    });
  }

  /** A deliberate move elsewhere settles the question of where playback belongs. */
  forgetPause(): void {
    this.pauseAnchor = null;
  }

  /**
   * Whatever the guard was waiting for died with the source.
   *
   * Cleared unconditionally, before anything else can fail on the way out: a wait nobody will
   * answer is a spinner for ever.
   */
  destroy(): void {
    this.startingFrom = null;
    this.stopWatchingForFirstFrame();
    this.startingWait = Date.now();
    this.setStarting(null, "lecteur détruit");
    if (this.pauseSettleTimer) clearInterval(this.pauseSettleTimer);
    this.pauseSettleTimer = null;
    this.video.removeEventListener("play", this.onPlayDuringHold);
    this.audioHold = null;
    this.pauseAnchor = null;
  }

  /** The last pause and resume, in positions, for the technical panel. */
  get debug(): Record<string, string> {
    const trace = this.resumeTrace;
    if (!trace) return {};
    return {
      "Dernière pause": `arrêt ${trace.paused.toFixed(3)} → repos ${trace.settled.toFixed(3)}${
        trace.asserted > 0 ? ` → recalé ×${trace.asserted}` : ""
      }`,
      "Dernière reprise": Number.isNaN(trace.play)
        ? "—"
        : `départ ${trace.play.toFixed(3)} → 1er tick ${trace.tick?.toFixed(3) ?? "—"}`,
      "Délai du bouton lecture":
        trace.latencyMs === null
          ? "—"
          : `${trace.latencyMs} ms · après ${((trace.pausedForMs ?? 0) / 1000).toFixed(1)} s de pause`,
    };
  }
}
