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
import { isNetworkFailure } from "./byteSource";
import { BufferQueue } from "./bufferQueue";
import { PlaybackGuard } from "./playbackGuard";
import { containerAccepts, playabilityOf, sourceConstructor, type MediaSourceCtor } from "./mseSupport";

// Kept exported from here as well: every caller of these already reaches for this module, and
// moving where they live should not mean touching a dozen call sites.
export { containerAccepts, playabilityOf, canRebuildAudioBuffer } from "./mseSupport";

/** How far ahead of the playhead to keep buffered. Enough to ride out a slow read, not a download. */
const TARGET_BUFFER_SECONDS = 30;

/** How long a clock may stand still, while playing with media ahead of it, before it is pushed. */
const FROZEN_CLOCK_MS = 1500;

/**
 * How far it is pushed — inside the media rather than onto its edge, which is what froze it.
 *
 * Deliberately larger than the movement threshold above: a step exactly the size of it reads as
 * not having moved on the next tick, so a clock that had just been unstuck was still counted as
 * frozen and pushed again.
 */
const FROZEN_STEP = 0.08;

/** And how many times, before leaving an element alone with whatever it is doing. */
const MAX_FROZEN_NUDGES = 3;

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

/** Only the opening handful of segments is recorded: after that the record says nothing new. */
const TRACED_APPENDS = 4;

/** How much already-played media to keep before evicting, so a short step back does not re-fetch. */
const KEEP_BEHIND_SECONDS = 30;

export interface MseCallbacks {
  /**
   * Fatal: playback cannot continue on this path. The caller decides what to say and offer.
   *
   * `kind` is what makes that decision possible. A network failure is not a reason to give up on
   * this path — it is a reason to wait, because every other path needs the same network.
   */
  onError: (message: string, kind?: "network" | "playback") => void;
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

/** How far before the end of the held picture the reader starts building segments in full again. */
const VIDEO_SKIP_MARGIN = 6;

export class MseSource {
  private readonly source: MediaSource | ManagedMediaSource;
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;
  private videoOps: BufferQueue | null = null;
  private audioOps: BufferQueue | null = null;
  /** Consecutive refused appends. A single one is worth retrying; a run of them is not. */
  private appendFailures = 0;
  /**
   * Everything about the element's own clock — pausing, resuming, landing after a seek, holding a
   * picture that would run on without sound. A different subject from moving bytes, with a
   * different kind of evidence behind it, so it lives in its own file.
   */
  private readonly guard: PlaybackGuard;
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


  private seeksServed = 0;
  private recoveries = 0;
  private recoveryTarget = -1;
  private recoveryStreak = 0;
  private lastRecoveryAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** For the frozen-clock check: where the clock was, since when, and how often it was pushed. */
  /** How far ahead to fill. Lowered, for this file only, if the browser says it cannot hold it. */
  private targetBuffer = TARGET_BUFFER_SECONDS;
  private lastClockAt = -1;
  private frozenSince: number | null = null;
  private frozenNudges = 0;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly remuxer: Remuxer,
    private plan: RemuxPlan,
    private readonly callbacks: MseCallbacks,
    Source: MediaSourceCtor
  ) {
    this.source = new Source();
    // The getters below need the instance by reference: a property cannot be a getter over it.
    const self = this;
    // Handed a narrow view of the source rather than the source itself: the guard decides *when*
    // the playhead should move, and this half remains the only thing that moves media.
    this.guard = new PlaybackGuard(
      video,
      {
        get destroyed() {
          return self.destroyed;
        },
        get delaySeconds() {
          return self.delaySeconds;
        },
        get playable() {
          return self.playable;
        },
        get audioRanges() {
          return self.audioBuffer?.buffered ?? null;
        },
        seek: (seconds, because) => this.seek(seconds, because),
        noteSeekTarget: (seconds) => {
          this.lastSeekTarget = seconds;
        },
      },
      callbacks.onStarting
    );
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
    // Opening a film is a request to be somewhere, and it is about to be answered with media
    // that begins a fraction of a second later — a file with B-frames presents its first picture
    // 210 ms in. Declared as a landing so the playhead may be put onto that media even though
    // the element, having nothing to play yet, is still paused.
    this.guard.opened(this.video.currentTime);

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
    this.video.addEventListener("pause", this.guard.paused);
    this.video.addEventListener("play", this.onPlay);
    this.video.addEventListener("playing", this.request);
    this.video.addEventListener("playing", this.onResumed);
    this.lastAppendAt = Date.now();
    this.watchdogTimer = setInterval(this.watchdog, WATCHDOG_MS);

    // Started, not waited for. Filling runs until there is a comfortable amount of media, and
    // waiting for that before declaring the player ready makes the whole session hostage to it:
    // a browser that accepts segments and keeps nothing from them leaves the depth at zero, the
    // loop reading the film from end to end, and the viewer looking at a spinner that has no
    // reason to ever stop. The element reports its own readiness, and the controls show the wait.
    void this.fill();
  }





  /** The clock moved: the guard decides what that means, the source reads on. */
  private readonly request = () => {
    this.guard.clockTicked();
    void this.fill();
  };

  /**
   * A clock is only frozen relative to the last time the element said it was running.
   *
   * Both events reset it, and both matter: `play` is fired the moment playback is *asked* for,
   * `playing` when it actually gets going, and between the two sits the whole of the resume
   * machinery putting the position back where the viewer left it. Counting through that window
   * meant the frozen-clock check could push the playhead of an element that had just been handed
   * back — which is precisely what that machinery spends its time getting right.
   */
  private readonly onResumed = () => {
    this.frozenSince = null;
    this.lastClockAt = -1;
  };

  private readonly onPlay = () => {
    this.onResumed();
    this.guard.playing();
    void this.fill();
  };

  private readonly onElementError = () => {
    trace(`l'élément a échoué : ${this.elementState()}`);
  };

  private readonly onSourceClosed = () => {
    trace(`la MediaSource s'est fermée — ${this.elementState()}`);
  };





  private readonly onSeeking = () => {
    if (this.destroyed) return;
    const target = this.video.currentTime;
    // This object's own move, already being served — serving it again would clear the buffers
    // it is in the middle of refilling.
    if (Math.abs(target - this.lastSeekTarget) < 0.25) return void this.fill();
    // A step inside what is already buffered needs no work from the file at all.
    if (this.isBufferedAt(target)) return void this.fill();
    // A deliberate move settles the question of where playback belongs.
    this.guard.forgetPause();
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

  /** The element's own playable ranges, written out. */
  private playableSpans(): string {
    const ranges = this.video.buffered;
    const spans: string[] = [];
    for (let i = 0; i < ranges.length; i++) spans.push(`${ranges.start(i).toFixed(2)}–${ranges.end(i).toFixed(1)}`);
    return spans.join(" · ") || "vide";
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
        if (lead >= this.targetBuffer) break;
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
                  `${segment.video.reduce((n, f) => n + f.byteLength, 0)} o vidéo en ` +
                  `${segment.video.length} fragment(s), ${segment.audio?.byteLength ?? 0} o audio`
              : "le remultiplexeur ne produit plus de segment (fin du fichier)"
          );
        }

        if (!segment) {
          this.ended = true;
          // Through the queue, for the same reason as the duration above: ending a stream while
          // a buffer is updating throws, and here the throw would be read as a refused append —
          // the film would be recovered from, at its own end, instead of simply finishing.
          if (this.videoOps) await this.videoOps.enqueue(() => this.endStream()).catch(() => this.endStream());
          else this.endStream();
          break;
        }

        // The delay is only known once the first segment has been built, and the duration has to
        // account for it: the media now ends that much later than the file does.
        if (this.delaySeconds === 0) {
          this.delaySeconds = this.remuxer.diagnostics().presentationDelaySeconds;
          const duration = this.plan.durationSeconds + this.delaySeconds;
          // Guarded rather than assumed. Setting a MediaSource's duration throws outright while
          // any of its buffers is updating, and eviction queues a removal without waiting for
          // it — so this could land in that window and abort a fill loop that had nothing wrong
          // with it. What it costs when it fails is the far end of the scrub bar, briefly.
          if (this.source.readyState === "open" && duration > 0 && Number.isFinite(duration)) {
            try {
              this.source.duration = duration;
            } catch {
              // Busy. The next segment sets it, and nothing depends on it being set now.
            }
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
        if (this.videoOps && sendVideo) {
          // One call per fragment. Handing over a whole keyframe group at once is what this
          // splitting exists to stop — see Remuxer.fragmentise — so joining them back together
          // here would undo all of it.
          for (const fragment of segment.video) {
            await this.appendTo(this.videoOps, fragment, generation);
            if (this.generation !== generation || this.destroyed) break;
          }
        }
        if (segment.audio && this.audioOps) await this.appendTo(this.audioOps, segment.audio, generation);
        // A seek arrived while those were in flight: this loop's appends were discarded, so its
        // reading of where the media is would be about a position no longer being served.
        if (this.generation !== generation || this.destroyed) break;

        this.readUpTo = segment.endSeconds;
        this.guard.nudgeIntoBuffer();
        this.lastAppendAt = Date.now();

        const depth = this.bufferedEnd();
        if (this.appendsTraced <= TRACED_APPENDS && this.appendsTraced > 0) {
          trace(`après envoi : tampon jusqu'à ${depth.toFixed(1)} s, tête à ${this.video.currentTime.toFixed(1)} s`);
          // There is something to play now, which there was not when the element was first asked
          // to. Only acts on a start the element abandoned; a viewer's own pause is left alone.
          this.guard.mediaArrived();
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
        // Traced, not shown. The viewer saw nothing: the segment was fetched again and the film
        // did not stop. A banner here interrupts somebody to tell them about a problem that has
        // already been solved — the record is the right place for it.
        trace(`segment refusé, repris — ${this.elementState()}`);
        return;
      }
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.callbacks.onError(`${detail} ${this.elementState()}`, isNetworkFailure(error) ? "network" : "playback");
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
        this.quotaHit();
        return;
      }
      throw error;
    }
  }


  /** Declares the stream over, if it still can be. Never throws. */
  private endStream(): void {
    try {
      if (this.source.readyState === "open") this.source.endOfStream();
    } catch {
      // Already ended, or torn down under us.
    }
  }

  /**
   * The browser has taken all it will hold.
   *
   * Two things follow, and only the first of them was being done. Media behind the playhead is
   * dropped, which frees room — *unless* the playhead has not travelled far enough for there to
   * be any, which in the first half-minute of a film is always. In that case every segment sent
   * is refused and silently dropped, and after eight of them the fill loop concludes the browser
   * is keeping nothing at all and hands the film away. The cause and the diagnosis would have
   * had nothing to do with each other.
   *
   * So the target comes down instead, to a little less than what is actually being held. That is
   * measured rather than guessed, it costs nothing on a browser that never refuses anything —
   * which is every browser tested here — and it lasts only as long as this MediaSource.
   */
  private quotaHit(): void {
    const held = this.lead;
    this.evict();
    const room = Math.max(MIN_BUFFER_SECONDS, Math.floor(held * 0.75));
    if (room < this.targetBuffer) {
      trace(`tampon plein à ${held.toFixed(1)} s : on vise ${room} s pour ce fichier`);
      this.targetBuffer = room;
    }
  }

  private evict(): void {
    const until = this.video.currentTime - KEEP_BEHIND_SECONDS;
    // Traced either way, including when there is nothing to free: whether this ever happens on a
    // real device was, until now, unknowable from the record.
    trace(`éviction demandée à ${this.video.currentTime.toFixed(1)} s — ${until <= 0 ? "rien derrière la tête" : `jusqu'à ${until.toFixed(1)} s`}`);
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
          trace(`saut refusé, repris — ${detail}`);
          return;
        }
        this.callbacks.onError(`${detail} ${this.elementState()}`, isNetworkFailure(error) ? "network" : "playback");
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
    this.guard.seekServed(playerSeconds);
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
    // A seek already on its way: leave it to arrive. Pushing the playhead in the middle of one
    // would be this player seeking against itself.
    if (this.requestedSeek !== null) return;
    // On media: the only stall left is a clock that has stopped anyway, which is its own check.
    if (this.isBufferedAt(now)) return this.watchForFrozenClock(now);

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
   * The other kind of stall: playing, media under the playhead, and a clock that does not move.
   *
   * Everything above watches for a playhead standing on nothing, because that was every stall
   * there had been. This one is the opposite shape and nothing could see it: an episode opened
   * from the beginning reported itself as playing, with the playhead on the media and twenty
   * seconds buffered ahead of it, and stayed at 0:00. The element was waiting on a seek to the
   * exact first instant of the buffered range that never completed — so from here it looked
   * perfectly healthy, which is why it went unnoticed until it was reported from a phone.
   *
   * Answered the same way as the other, and just as bluntly: ask for the position again, a
   * fraction of a second further in, which is what completes a seek that never resolved.
   */
  private watchForFrozenClock(now: number): void {
    const moved = Math.abs(now - this.lastClockAt) > 0.05;
    if (moved || this.frozenSince === null) {
      this.lastClockAt = now;
      this.frozenSince = moved || this.frozenSince === null ? Date.now() : this.frozenSince;
      if (moved) this.frozenNudges = 0;
      return;
    }
    if (Date.now() - this.frozenSince < FROZEN_CLOCK_MS) return;
    // Only when there is plainly something to play: a clock that is not moving because the
    // buffer ran dry is an ordinary wait, and the fill loop is already on it.
    if (this.lead < 1 || this.frozenNudges >= MAX_FROZEN_NUDGES) return;

    this.frozenNudges += 1;
    this.frozenSince = Date.now();
    trace(`horloge figée à ${now.toFixed(2)} s avec ${this.lead.toFixed(1)} s en avance — on redemande la position`);
    this.guard.forgetPause();
    this.video.currentTime = now + FROZEN_STEP;
  }

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
        // Also traced rather than shown, and for a sharper reason: giving up here does not mean
        // the position is unreachable. The remuxer's own index back-up regularly lands it a
        // moment later — measured on the file with the false keyframes — so the banner announced
        // a failure to a viewer whose film was about to carry on, and stayed up while it did.
        trace(`reprise abandonnée après ${this.recoveryStreak} tentatives vers ${target.toFixed(1)} s`);
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
  /** Keeps the picture from running on without sound — see PlaybackGuard. */
  beginAudioHold(): void {
    this.guard.beginAudioHold();
  }

  /** Watches for the sound to come back, so the picture can move again. */
  armAudioRelease(): Promise<void> {
    return this.guard.armAudioRelease();
  }

  /** Lets the picture go again — for a caller whose change of track came to nothing. */
  releaseAudioHold(): void {
    this.guard.releaseAudioHold();
  }

  get lost(): boolean {
    return !this.destroyed && this.source.readyState === "closed";
  }

  /** Where the viewer was, for a caller that has to rebuild and wants to come back to it. */
  get position(): number {
    return this.video.currentTime;
  }

  /**
   * L'espace colorimétrique d'une image telle que l'élément la rend, demandé une seule fois.
   *
   * Purement informatif : rien ici n'agit dessus. La réponse dit si les vraies valeurs HDR ont
   * survécu au décodage matériel — `bt2020 · pq` — ou si le navigateur a déjà converti l'image
   * avant qu'on puisse la voir, auquel cas elle revient en RGB 8 bits. C'est la seule mesure qui
   * distingue les deux, et un relevé qui la porte évite d'avoir à refaire la démonstration.
   *
   * Une seule fois, et le résultat gardé : construire une image 4K à chaque rafraîchissement du
   * panneau pour lire trois champs coûterait bien plus que ce qu'elle apprend.
   */
  private colorProbe: string | null = null;

  private frameColorSpace(): string {
    if (this.colorProbe) return this.colorProbe;
    const Frame = (globalThis as { VideoFrame?: new (source: CanvasImageSource) => VideoFrame }).VideoFrame;
    if (!Frame || this.video.readyState < 2) return "pas encore lisible";
    let frame: VideoFrame | null = null;
    try {
      frame = new Frame(this.video);
      const space = frame.colorSpace;
      this.colorProbe = `${space.primaries ?? "?"} · ${space.transfer ?? "?"} · ${space.matrix ?? "?"} · ${frame.format ?? "format non déclaré"}`;
      return this.colorProbe;
    } catch (error) {
      this.colorProbe = `refusé (${error instanceof Error ? error.message : String(error)})`;
      return this.colorProbe;
    } finally {
      frame?.close();
    }
  }

  /** Images perdues sur images rendues, telles que l'élément lui-même les compte. */
  private frameQuality(): string {
    const quality = this.video.getVideoPlaybackQuality?.();
    if (!quality) return "non mesurable ici";
    const { droppedVideoFrames: dropped, totalVideoFrames: total } = quality;
    if (total === 0) return "aucune image rendue";
    return `${dropped} / ${total} (${((dropped / total) * 100).toFixed(1)} %)`;
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
      // The two facts that would have named the frozen-clock stall in one glance instead of
      // three reports: what the *element* can play — the intersection of the buffers, not the
      // video buffer alone — and whether it is waiting on a seek that never resolved.
      "Lisible par l'élément": this.playableSpans(),
      "En cours de saut": this.video.seeking ? "oui" : "non",
      // La seule mesure qui sépare « le décodeur n'y arrive pas » de « la cadence du film ne
      // tombe pas juste sur celle de l'écran ». Sans elle, une lecture qui n'attend jamais et
      // dont le tampon a trente secondes d'avance ne dit toujours rien sur ce qu'on voit.
      "Images perdues": this.frameQuality(),
      "Couleurs de l'image": this.frameColorSpace(),
      "MediaSource": `${this.source.readyState}${this.streamingWanted ? "" : " · en pause"}`,
      "Lecture en cours": this.fillTask ? "oui" : "non",
      "Sauts servis": `${this.seeksServed}${this.recoveries > 0 ? ` · ${this.recoveries} reprises` : ""}`,
      ...this.guard.debug,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.guard.destroy();
    this.generation += 1;

    this.source.removeEventListener("startstreaming", this.request);
    this.video.removeEventListener("timeupdate", this.request);
    this.video.removeEventListener("waiting", this.request);
    this.video.removeEventListener("seeking", this.onSeeking);
    this.video.removeEventListener("pause", this.guard.paused);
    this.video.removeEventListener("play", this.onPlay);
    this.video.removeEventListener("playing", this.request);
    this.video.removeEventListener("playing", this.onResumed);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.video.removeEventListener("error", this.onElementError);
    this.source.removeEventListener("sourceclose", this.onSourceClosed);

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
