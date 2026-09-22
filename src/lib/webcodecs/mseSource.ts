// Feeds remuxed segments to a real <video> element through MediaSource.
//
// This is the path that costs the least and gives the most: the browser decodes in hardware,
// composites the picture itself, drives its own audio clock, and handles HDR natively. Nothing
// here touches a pixel or a sample — it only decides what to hand over and when.
//
// Anything that goes wrong is reported, never worked around silently. A player that quietly falls
// back leaves you unable to tell a path that works from a path that was never used.

import { playerWarning, type PlayerWarning } from "./playerWarning";
import type { Remuxer, RemuxPlan, TrackedCue } from "./remuxer";
import { trace, traceRecent } from "./trace";
import { describeNetwork, isNetworkFailure, isReadAbandoned } from "./byteSource";
import { BufferQueue } from "./bufferQueue";
import { PlaybackGuard } from "./playbackGuard";
import { NO_INDEX_REACH_SECONDS, reachable, seekArrived } from "./seekArrival";
import { LANDING_REACH_SECONDS, SeekLifecycle, landingFor } from "./seekLifecycle";
import { containerAccepts, playabilityOf, sourceConstructor, type MediaSourceCtor } from "./mseSupport";

// Kept exported from here as well: every caller of these already reaches for this module, and
// moving where they live should not mean touching a dozen call sites.
export { containerAccepts, playabilityOf } from "./mseSupport";

/** How far ahead of the playhead to keep buffered. Enough to ride out a slow read, not a download. */
const TARGET_BUFFER_SECONDS = 30;

/** How long a clock may stand still, while playing with media ahead of it, before it is pushed. */
const FROZEN_CLOCK_MS = 1500;

/**
 * Et combien de temps quand l'élément est encore en train de sauter.
 *
 * Un saut au milieu d'un groupe d'images se décode depuis l'image clé précédente : neuf secondes
 * de 4K avant d'arriver à la cible dans 1917, soit plus d'une seconde et demie sur un iPhone
 * comme sur un PC. Poussé à 1,5 s, le saut repartait de l'image clé, et encore, et encore
 * (22/09/2026, « une seconde de lecture pour deux de chargement »). Un saut qui ne se résout
 * vraiment jamais — celui posé pile sur le bord du média, pour lequel la poussée existe — est
 * toujours poussé, simplement plus tard.
 */
const FROZEN_SEEKING_MS = 6000;

/**
 * How far it is pushed — inside the media rather than onto its edge, which is what froze it.
 *
 * Deliberately larger than the movement threshold above: a step exactly the size of it reads as
 * not having moved on the next tick, so a clock that had just been unstuck was still counted as
 * frozen and pushed again.
 */
const FROZEN_STEP = 0.08;

/**
 * And how many times, before the push gives way to a real recovery.
 *
 * It used to be "before leaving an element alone with whatever it is doing" — and the counter only
 * resets when the clock moves, so a clock that three pushes did not free was never looked at
 * again: playing, media ahead, and nothing whatsoever trying to get it going.
 */
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

/** Seeks to the same spot, in a row, before that spot is given up on and the ladder climbs. */
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Recoveries of any kind, anywhere, with no playback in between, before the ladder climbs anyway.
 *
 * The window above resets the count at one spot once attempts stop being rapid — right for a
 * spot that fails again a minute later, wrong for one that fails every six seconds for ever. This
 * bound does not care about spacing: only real playback clears it (`PLAYED_TO_CLEAR_SECONDS`).
 * Above the three rapid attempts plus the keyframe step, so the ordinary ladder never reaches it.
 */
const MAX_UNPLAYED_ATTEMPTS = 8;

/** Seconds of the clock genuinely running before the ladder goes back to its first rung. */
const PLAYED_TO_CLEAR_SECONDS = 3;

/** How far inside the next keyframe's group the keyframe step lands — inside, not on its edge. */
const NEXT_KEYFRAME_MARGIN = 0.1;

/**
 * How long a playing clock may cover less than a second before the stall is written to the log.
 *
 * Longer than any recovery here takes to act (1.5 s for a frozen clock, 0.7 s for a playhead on
 * nothing), so a line means those did not settle it — the case nothing on the server could see.
 */
const STALL_REPORT_MS = 5000;

/** And no second line within this long, however the clock flaps in between. */
const STALL_REPORT_COOLDOWN_MS = 60_000;

/**
 * L'autre forme de blocage, celle où l'horloge avance : autant de secondes courues sans rien sous
 * la tête avant de l'écrire. 22/09/2026, iPhone : « le temps avance de plusieurs dizaines de
 * secondes, pas d'image, et ça ne s'arrête pas tant que je ne ressaute pas » — invisible pour la
 * ligne `stall`, qui ne voit qu'une horloge immobile.
 */
const RUNAWAY_REPORT_SECONDS = 3;


/** How much of the trace a stall line carries: enough to hold the seek or skip that led to it. */
const STALL_TRACE_MS = 20_000;

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

/** Envois tracés après chaque saut : de quoi voir la tête rejoindre le média, pas davantage. */
const TRACED_APPENDS_PER_SEEK = 6;

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
  onWarning?: (warning: PlayerWarning) => void;
  /**
   * Play has been pressed and the clock has not moved yet, or null once it has.
   *
   * Reported as a fact rather than as a platform: on iOS the pipeline needs a moment to refill
   * the sound it was told to discard, and on a desktop the same condition clears within a frame.
   * A caller can therefore show that something is happening without ever asking which browser it
   * is in, and without inventing a delay where there is none.
   */
  onStarting?: (startedAt: number | null) => void;
  /**
   * The clock has stood still for `STALL_REPORT_MS` while the element says it is playing — once per
   * stall, for the playback log. Flat facts (see `stallReport`), nothing to act on: the recoveries
   * are already under way, and this is how anyone learns afterwards what they were up against.
   */
  onStall?: (facts: Record<string, unknown>) => void;
}

export class MseSource {
  private readonly source: MediaSource | ManagedMediaSource;
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;
  private videoOps: BufferQueue | null = null;
  private audioOps: BufferQueue | null = null;
  /** Consecutive refused appends. A single one is worth retrying; a run of them is not. */
  private appendFailures = 0;
  /**
   * Everything about the element's own clock — pausing, resuming, landing after a seek, starting
   * a film the element gave up on. A different subject from moving bytes, with a
   * different kind of evidence behind it, so it lives in its own file.
   */
  private readonly guard: PlaybackGuard;
  /** Pas de démarrage dû à l'ouverture : la garde ne relance pas un élément laissé à l'arrêt. */
  private startPaused = false;
  private objectUrl: string | null = null;
  /** The read loop in flight, if any. A seek has to let it finish before moving the reader. */
  private fillTask: Promise<void> | null = null;
  private destroyed = false;
  private ended = false;
  /** Bumped by every seek, so appends already in flight are recognised as stale and dropped. */
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  /** Le saut : demandé, servi, en route, arrivé — voir `SeekLifecycle`. */
  private readonly seekState = new SeekLifecycle();
  private delaySeconds = 0;
  /**
   * Où le film doit s'ouvrir, tant que le média n'est pas encore là pour l'y recevoir.
   *
   * Voir `placePendingStart`. `null` dès que la tête y a été posée, et dès le départ pour une
   * ouverture au début, qui n'a personne à attendre.
   */
  private pendingStart: number | null = null;
  private lastAppendAt = 0;
  /** How far the reader has read, on the player's clock — for the trace of a misplaced reader. */
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
  /** Every push over the session, for the `stop` line — the one above resets when the clock moves. */
  private frozenNudgesTotal = 0;
  /**
   * Which rung of the recovery ladder has been climbed since the clock last really played: 0 none,
   * 1 the keyframe step, 2 handed to the host for a rebuild. See `escalate`.
   */
  private escalation = 0;
  private escalations = 0;
  /** Recoveries since the clock last really played — see `MAX_UNPLAYED_ATTEMPTS`. */
  private unplayedAttempts = 0;
  /** Seconds the clock has genuinely run since the last recovery. */
  private playedSinceTrouble = 0;
  /**
   * Handed to the host: nothing more this source can try. Reads as `lost`, so the host's own
   * rebuild — its budget, its skip past a place that failed twice — takes over from here.
   */
  private stuck = false;
  /** Où reprendre après `handOver` — voir `position`. */
  private handedOverAt: number | null = null;
  /** For the stall line: where the clock was, since when, and whether this stall was written. */
  private stallClockAt = -1;
  private stallSince: number | null = null;
  private stallReported = false;
  private lastStallReportAt = -Infinity;
  /** The clock as last seen by the watchdog, to tell playback from a jump. */
  private tickClockAt = -1;
  /**
   * Secondes d'horloge écoulées sans média sous la tête, depuis la dernière fois qu'il y en avait.
   * Voir `RUNAWAY_REPORT_SECONDS`.
   */
  private runawaySeconds = 0;
  /** Le tour où la tête hors de sa place a été traitée — pour que le chien de garde n'agisse pas deux fois. */
  private headAwayHandledAt = -1;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly remuxer: Remuxer,
    private readonly plan: RemuxPlan,
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
        seek: (seconds, because) => this.seek(seconds, because),
        noteSeekTarget: (seconds) => {
          // Un pas volontaire autour de la cible la déplace : ce n'est pas un départ.
          this.seekState.moved(seconds);
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
    startSeconds = 0,
    /** Ouvrir sans qu'un démarrage soit dû — voir `RemuxPlaybackOptions.startPaused`. */
    startPaused = false
  ): Promise<MseSource> {
    const Source = sourceConstructor();
    if (!Source) throw new Error("Ce navigateur ne propose pas MediaSource.");

    const instance = new MseSource(video, remuxer, plan, callbacks, Source);
    instance.startPaused = startPaused;
    await instance.open(startSeconds);
    return instance;
  }

  /** Where the player's clock sits relative to the file's. Already applied to every seek here. */
  get presentationDelay(): number {
    return this.delaySeconds;
  }

  private appendsTraced = 0;
  /**
   * Envois depuis le dernier saut (ou l'ouverture) : seuls les premiers sont tracés. Écrite à
   * chaque segment jusqu'au 22/09/2026, la ligne « après envoi » occupait à elle seule les quarante
   * étapes des lignes `seek` et `stall`, et masquait ce qui s'y était passé.
   */
  private appendsSinceSeek = 0;
  /** Le premier envoi après un saut écrit ce que le réseau a coûté — voir `NetworkWindow`. */
  private seekNetworkPending = false;

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

    // From here on the element holds the source: the object URL keeps the MediaSource alive and
    // `video.src` still points at it. `addSourceBuffer` is a real failure path — Firefox on
    // Windows can claim support for a codec through `MediaSource.isTypeSupported` and then refuse
    // it here (see codecSupport.ts) — and the init appends below can reject too. Without this the
    // object outlived its own failure to open, since `revokeObjectURL` only ever runs in destroy().
    try {
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
      //
      // Le lecteur est envoyé chercher le bon endroit tout de suite ; la *tête*, elle, attend que
      // ce média soit arrivé — voir `placePendingStart`. Déplacer la tête ici, alors que seuls les
      // segments d'initialisation ont été envoyés et que le tampon est vide, laissait WebKit dans
      // un `seeking` qu'il ne résolvait plus jamais : mesuré sur un iPhone, un film rouvert à
      // 23:24 restait figé avec trente secondes de média sous la tête et pas une image décodée,
      // pendant que le chien de garde redemandait la position toutes les 1,8 s sans effet. Un saut
      // *pendant* la lecture n'a jamais eu ce défaut — là, le média et le décodeur existent déjà,
      // et c'est toute la différence.
      if (startSeconds > NO_INDEX_REACH_SECONDS && reachable(this.remuxer.seekable, startSeconds)) {
        this.remuxer.seekTo(startSeconds);
        this.seekState.moved(startSeconds);
        this.pendingStart = startSeconds;
      }
      // Opening a film is a request to be somewhere, and it is about to be answered with media
      // that begins a fraction of a second later — a file with B-frames presents its first picture
      // 210 ms in. Declared as a landing so the playhead may be put onto that media even though
      // the element, having nothing to play yet, is still paused.
      //
      // Pour une ouverture différée, la même déclaration est refaite au moment où la tête est
      // posée : c'est là que le film s'ouvre vraiment, et l'annoncer ici la placerait à un endroit
      // où la tête n'ira pas.
      if (this.pendingStart === null) this.guard.opened(this.video.currentTime, !this.startPaused);

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
      this.video.addEventListener("seeked", this.onSeeked);
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
    } catch (error) {
      // Each step of destroy() is guarded or optional, so tearing a half-open source down cannot
      // replace the error that names why the file would not open.
      this.destroy();
      throw error;
    }
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
    this.seekState.started(target, Date.now());
    // This object's own move, already being served — serving it again would clear the buffers
    // it is in the middle of refilling.
    if (this.seekState.isOwnMove(target)) return void this.fill();
    // A deliberate move settles the question of where playback belongs — et c'est vrai aussi d'un
    // saut dans ce qui est déjà chargé. Oublié sur ce raccourci jusqu'au 22/09/2026 : pause, saut
    // en avant, Lecture, et la garde ramenait la tête à sa position de pause.
    this.guard.forgetPause();
    // A step inside what is already buffered needs no work from the file at all.
    if (this.isBufferedAt(target)) return void this.fill();
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

  /**
   * Où le lecteur travaille — la tête, ou la position qu'elle n'a pas encore rejointe.
   *
   * Tout ce qui mesure « ce qu'on a d'avance » partait de `currentTime`, ce qui était juste tant
   * que la tête était toujours là où le film s'ouvre. Une ouverture en cours de film envoie
   * maintenant son média *avant* de déplacer la tête — c'est ce qui évite à WebKit un `seeking`
   * qu'il ne résout jamais (voir `pendingStart`). Pendant ces quelques centaines de
   * millisecondes, la tête est à zéro et le média arrive à 1200 s : mesurée depuis la tête,
   * l'avance vaut donc zéro segment après segment.
   *
   * Deux conclusions fausses en découlaient, et les deux ramenaient le film à son début : le
   * détecteur de segments sans effet concluait que le navigateur ne retenait rien, et le contrôle
   * d'égarement, que le lecteur remplissait un endroit où personne n'était. « Reprendre »
   * repartait de zéro — deux fois sur trois, selon la vitesse à laquelle l'élément publie ses
   * plages.
   */
  private get anchor(): number {
    return this.pendingStart ?? this.video.currentTime;
  }

  /** How much media sits between the playhead and the end of its own run. */
  private get lead(): number {
    return this.bufferedEnd() - this.anchor;
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
    const now = this.anchor;
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
        if (this.seekState.requested !== null) break;

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

        if (this.videoOps) {
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
        // Avant le reste : tant que la tête n'est pas posée, il n'y a ni atterrissage à faire ni
        // démarrage à réclamer.
        this.placePendingStart();
        this.guard.nudgeIntoBuffer();
        this.lastAppendAt = Date.now();

        if (this.seekNetworkPending) {
          this.seekNetworkPending = false;
          // La première image du saut est là : la lecture en avance reprend en entier.
          this.remuxer.seekSettled?.();
          // Mesure seulement : jamais sur le chemin d'une lecture.
          try {
            const network = this.remuxer.networkSinceSeek?.();
            if (network) trace(`réseau depuis le saut : ${describeNetwork(network)}`);
          } catch {
            /* rien */
          }
        }
        const depth = this.bufferedEnd();
        if (++this.appendsSinceSeek <= TRACED_APPENDS_PER_SEEK) {
          trace(`après envoi : tampon jusqu'à ${depth.toFixed(1)} s, tête à ${this.video.currentTime.toFixed(1)} s`);
        }
        // There is something to play now, which there was not when the element was first asked
        // to. Only acts on a start the element abandoned; a viewer's own pause is left alone.
        // À chaque envoi, et non plus au rythme de la trace : les deux étaient liés par accident.
        this.guard.mediaArrived();
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
        // for a moment after every seek — the element's ranges are the
        // *intersection* of the two buffers, so emptying the audio one empties them entirely.
        // Read as a distance, that is "infinitely far from the media", and this fired a recovery
        // at the exact moment the loop was already fetching what was missing. Each recovery is a
        // fresh seek, which empties the buffers again, which fires another: three recoveries in
        // nine seconds, and Safari closes the source. Only media that exists and is genuinely
        // far away means the reader is in the wrong place.
        //
        // Et rien de tout cela ne s'applique tant que la tête n'a pas été posée. Une ouverture en
        // cours de film demande son média *avant* de déplacer la tête — c'est ce qui évite à
        // WebKit de rester bloqué sur un `seeking` qu'il ne résout plus (voir `pendingStart`). Le
        // média est alors loin de la tête par construction, pendant les quelques dizaines de
        // millisecondes qui séparent le premier envoi de la première plage tamponnée visible.
        // Lu comme un égarement, ce délai déclenchait un saut vers la tête, c'est-à-dire vers
        // zéro : on cliquait « Reprendre », le remultiplexeur ouvrait bien à 1315 s, et le film
        // repartait du début. Deux fois sur trois, selon la vitesse à laquelle l'élément publie
        // ses plages — d'où une reprise qui semblait marcher « quand elle voulait ».
        // Et rien de tout cela tant que la tête n'a pas atterri : le lecteur remplit alors vers
        // une position que personne n'occupe encore, par construction, et `placePendingStart` l'y
        // posera dès que le média la couvrira. Il n'y a rien à récupérer, seulement à attendre.
        const distance = this.pendingStart !== null ? 0 : this.distanceToMedia(this.anchor);
        if (Number.isFinite(distance) && distance > MISPLACED_SECONDS) {
          trace(
            `reprise : média à ${distance.toFixed(1)} s de la tête (${this.anchor.toFixed(1)} s), ` +
              `lecteur à ${this.readUpTo.toFixed(1)} s`
          );
          if (this.recover(this.anchor)) break;
        }
      }
    } catch (error) {
      if (this.destroyed) return;
      // Une lecture coupée par un saut : ce n'est pas un segment refusé, et il n'y a rien à
      // reprendre — le saut qui l'a coupée repositionne tout derrière.
      if (isReadAbandoned(error)) return;
      // Reported by the viewer as a freeze that a second seek or a language change undoes — so
      // nothing was actually lost, and declaring playback over was the wrong answer. A refused
      // append is retried from where the playhead is; only a run of them is a real fault.
      this.appendFailures += 1;
      if (this.appendFailures <= MAX_APPEND_FAILURES && this.recover(this.anchor)) {
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
    this.seekState.request(playerSeconds);
    // Tout de suite, sans attendre que le saut soit servi : les lectures réseau de la position
    // quittée sont coupées, et celles du saut partent. Sans ça, le saut attendait la fin d'une
    // lecture déjà inutile — jusqu'à deux secondes depuis un serveur lointain (22/09/2026).
    // Gardé : une détection qui lève sur le chemin d'un saut ne doit pas devenir l'échec du saut.
    if (this.remuxer.seekable) {
      try {
        this.remuxer.prepareSeek?.(Math.max(0, playerSeconds - this.delaySeconds));
      } catch {
        /* le saut se fera sans avance */
      }
    }
    this.pending = this.pending
      .then(() => {
        const target = this.seekState.requested;
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
        if (this.appendFailures <= MAX_APPEND_FAILURES && this.recover(this.anchor)) {
          trace(`saut refusé, repris — ${detail}`);
          return;
        }
        this.callbacks.onError(`${detail} ${this.elementState()}`, isNetworkFailure(error) ? "network" : "playback");
      });
    return this.pending;
  }







    private async performSeek(requested: number): Promise<void> {
    if (this.destroyed) return;

    // Un saut demandé remplace l'ouverture, il ne s'y ajoute pas. Sans cette ligne, sauter avant
    // que la tête ait été posée la ramènerait ensuite au point d'ouverture — le film repartirait
    // tout seul là où on venait de le quitter.
    this.pendingStart = null;

    // Clamped to the media, as a media element clamps its own currentTime. Without this, asking
    // for a time past the end sends the reader somewhere there is nothing to read, and the
    // recovery machinery then tries again and again to reach a place that does not exist.
    const end = this.plan.durationSeconds > 0 ? this.plan.durationSeconds + this.delaySeconds : Infinity;
    const playerSeconds = Math.min(Math.max(0, requested), Math.max(0, end - 0.25));

    // A file with no index cannot be reached at a time. Restarting from the beginning and
    // reading forward would look like the player thinking very hard and then, minutes later,
    // arriving — so it is refused, and playback carries on where it was.
    if (!reachable(this.remuxer.seekable, playerSeconds)) {
      this.callbacks.onWarning?.(playerWarning("noIndexSeek"));
      if (this.seekState.lastTarget >= 0) this.video.currentTime = this.seekState.lastTarget;
      return;
    }

    this.generation += 1;
    this.ended = false;
    this.seekState.serving(playerSeconds);
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

    // Pendant cette attente — une lecture réseau qui finit, deux secondes sur un serveur lointain —
    // d'autres sauts ont pu arriver : un doigt qui glisse sur la barre. Servir celui-ci lirait une
    // position déjà abandonnée, que le dernier attendrait à son tour (banc du 22/09/2026 : cinq
    // sauts en 0,6 s, 6,5 s pour arriver au dernier). On sert directement le plus récent.
    const latest = this.seekState.requested;
    if (latest !== null && latest !== requested) return this.performSeek(latest);

    // No abort() here any more. Cancelling an operation mid-flight leaves the buffer's parser in
    // a state the next append has to be careful about, and the queue already guarantees that
    // whatever was running has finished before this removal starts.
    for (const queue of [this.videoOps, this.audioOps]) {
      if (queue) await this.clear(queue);
    }

    this.remuxer.seekTo(Math.max(0, playerSeconds - this.delaySeconds));
    this.seekNetworkPending = true;
    this.appendsSinceSeek = 0;
    // Only when the element is not already there: reassigning would fire another seeking event
    // and start this over.
    if (Math.abs(this.video.currentTime - playerSeconds) > 0.05) this.video.currentTime = playerSeconds;

    // Served: the reader is where it was asked to be. Anything asked for after this point is a
    // new seek, and the refill below is free to run.
    this.seekState.served(playerSeconds);

    // Not awaited. A seek is finished the moment the reader is repositioned; waiting for thirty
    // seconds of media to be fetched before admitting so means the next seek queues behind a
    // download of a place the viewer has already left.
    void this.fill();
  }

  /**
   * Pose la tête de lecture à l'ouverture — une fois le média arrivé, jamais avant.
   *
   * C'est la moitié différée de l'ouverture à une position non nulle. Le remultiplexeur a été
   * envoyé au bon endroit dès le départ ; il ne restait qu'à attendre que ce qu'il rapporte soit
   * réellement sous la tête avant de l'y déplacer. Un `currentTime` posé sur un tampon vide est
   * une demande que WebKit accepte et n'honore jamais.
   *
   * Deux façons d'être arrivé, et la seconde compte autant que la première : la plage peut
   * contenir la cible, ou commencer juste après elle — un fichier à images B présente sa première
   * image 210 ms plus tard, et une ouverture qui tomberait dans cet intervalle attendrait un
   * instant que le fichier ne contient pas. On se pose alors au début de la plage, comme le fait
   * déjà l'atterrissage après un saut.
   */
  private placePendingStart(): void {
    const target = this.pendingStart;
    if (target === null) return;
    // Le même atterrissage qu'après un saut — voir `landingFor`.
    const landing = landingFor(this.video.buffered, target, LANDING_REACH_SECONDS);
    if (landing === null) return;
    this.pendingStart = null;
    trace(
      landing === target
        ? `ouverture : le média couvre ${landing.toFixed(1)} s, la tête y est posée`
        : `ouverture : le média commence après ${target.toFixed(1)} s, la tête est posée à ${landing.toFixed(2)} s`
    );
    this.seekState.moved(landing);
    this.video.currentTime = landing;
    this.guard.opened(landing, !this.startPaused);
  }

  private async clear(queue: BufferQueue): Promise<void> {
    // « ended » n'empêche pas de retirer : la spécification rouvre la source d'elle-même. Refusé
    // jusqu'au 22/09/2026, ce qui laissait l'ancienne piste dans le tampon quand on changeait de
    // langue une fois la fin du flux déclarée. Seule une source fermée n'a plus rien à vider.
    if (queue.buffer.buffered.length === 0 || this.source.readyState === "closed") return;
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
  /**
   * Arrivé : la tête est où le saut voulait qu'elle soit, et le saut n'est plus surveillé. Un
   * `seeked` loin de la cible, lui, ne vaut pas arrivée — voir `watchForHeadAway`.
   *
   * Il y avait ici, du 22/09/2026 au soir, une horloge arrêtée pendant les sauts sous WebKit
   * (vitesse 0, rendue à l'arrivée). Retirée après deux bancs iPhone : Safari a replacé une tête à
   * son ancienne position l'horloge arrêtée comme sans elle — c'est le filet qui l'a rattrapée les
   * deux fois —, elle rendait muettes l'horloge figée et les blocages, et Safari ne signale aucune
   * image à vitesse 0, si bien qu'on ne pouvait pas non plus l'attendre.
   */
  private readonly onSeeked = () => {
    if (this.destroyed) return;
    this.seekState.arrive(this.video.currentTime);
  };

  private readonly watchdog = () => {
    // A paused element is not stalled, and the frame it is showing is already on screen. Seeking
    // underneath it would move the picture for no reason and land the resume elsewhere.
    if (this.destroyed) return;
    // Before anything returns early: a stall is exactly the case where every check below has
    // decided there is nothing to do, and that decision is what the log line has to show.
    this.watchForStall();
    // Handed to the host, which is rebuilding: another seek from here would only race it.
    if (this.stuck) return;
    if (this.ended || !this.videoBuffer || this.video.paused) return;

    const now = this.video.currentTime;
    // La tête a quitté sa place et vient d'être renvoyée : rien d'autre à faire à ce tour.
    if (this.headAwayHandledAt === now) return;
    // A seek already on its way: leave it to arrive. Pushing the playhead in the middle of one
    // would be this player seeking against itself.
    if (this.seekState.requested !== null) return;
    // Une ouverture qui attend son média non plus. La tête est restée là où l'élément l'a laissée
    // — zéro — pendant que le film s'ouvre ailleurs, et c'est exactement ce que `pendingStart`
    // organise. « Rien sous la tête » est donc l'état normal ici, pas une panne : la ramener
    // ferait repartir du début un film qu'on venait de demander à reprendre.
    if (this.pendingStart !== null) return;
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
    if (!this.recover(now)) this.handOver(now);
  };

  /**
   * Notes whether the clock is really running, and writes a stall to the log when it is not.
   *
   * 22/09/2026 : a −10 s skip on an iPhone landed just before a keyframe, `seeked` fired, and the
   * clock then sat between 166 and 167 s for nineteen seconds under a spinner, until the viewer
   * seeked elsewhere. The log held the `seek` line and nothing after it: which recovery ran, what
   * the buffers held, whether anything was being read — all of it stayed on the phone.
   *
   * "Stood still" is measured as covering less than a second in `STALL_REPORT_MS`, not as an
   * unchanged value: the pushes and recoveries move the clock by fractions of a second, and a
   * stall they fail to cure must not read as playback.
   */
  private watchForStall(): void {
    const now = this.video.currentTime;
    const running = !this.video.paused && !this.video.ended;
    // What really playing looks like from a 250 ms tick: forward, by less than a jump. A seek is
    // neither, and does not count towards leaving the ladder.
    const delta = now - this.tickClockAt;
    this.tickClockAt = now;
    if (running && !this.video.seeking && delta > 0 && delta < 0.6) {
      this.playedSinceTrouble += delta;
      if (this.playedSinceTrouble >= PLAYED_TO_CLEAR_SECONDS) {
        this.escalation = 0;
        this.unplayedAttempts = 0;
      }
    }

    if (!running) {
      this.stallSince = null;
      return;
    }
    if (!this.stuck && this.watchForHeadAway(now, delta)) {
      this.stallSince = null;
      this.headAwayHandledAt = now;
      return;
    }
    // Un saut qui attend son média n'est pas un blocage : c'est l'attente du réseau, et la ligne
    // `seek` en porte déjà la durée. Compté, il écrivait une ligne `stall` à chaque saut lent
    // depuis un serveur lointain (banc du 22/09/2026 : quatre « blocages », tous des sauts).
    // Un saut resté `seeking` alors que le média est là, lui, reste compté — c'est le WebKit qui
    // ne résout pas son saut (1917 sur iPhone).
    if (this.video.seeking && !this.isBufferedAt(now)) {
      this.stallSince = null;
      return;
    }
    if (this.stallSince === null || Math.abs(now - this.stallClockAt) >= 1) {
      this.stallClockAt = now;
      this.stallSince = Date.now();
      this.stallReported = false;
      return;
    }
    const stalledMs = Date.now() - this.stallSince;
    if (stalledMs < STALL_REPORT_MS || this.stallReported) return;
    // Marked even when the cooldown holds it back: this stall has had its chance to be written.
    this.stallReported = true;
    if (Date.now() - this.lastStallReportAt < STALL_REPORT_COOLDOWN_MS) return;
    this.lastStallReportAt = Date.now();
    trace(`lecture bloquée depuis ${(stalledMs / 1000).toFixed(1)} s à ${now.toFixed(2)} s — ${this.elementState()}`);
    // Instrumentation on the path that is already failing: it must not become the failure.
    try {
      this.callbacks.onStall?.(this.stallReport(now, stalledMs));
    } catch {
      /* the log is not worth a player */
    }
  }

  /**
   * La tête hors de sa place — un seul détecteur pour les deux formes qu'on lui a connues.
   *
   * - **Pendant un saut** : elle s'éloigne de sa cible sans y être arrivée. Banc iPhone du
   *   22/09/2026 : trois sauts sur huit films partis de 20 à 650 s au-delà de leur cible, et un
   *   Titanic ramené par Safari à son ancienne position. L'élément se disait en train de sauter, ce
   *   qui rendait aveugles toutes les autres surveillances. Renvoyée vers sa **cible**.
   * - **Après** : l'horloge avance trois secondes sans rien sous la tête (2012 sur iPhone : 658
   *   images pour 55 s regardées, la tête posée à chaque envoi sur la fin de la vidéo reçue). Aucune
   *   cible à retrouver : reprise là où elle est, ce qui relit depuis l'image clé.
   *
   * Deux détecteurs jusqu'au 22/09/2026, qui écrivaient chacun leur ligne et appelaient chacun les
   * reprises ; un seul désormais, pour un seul fait. Par l'échelle habituelle des reprises, écrit
   * comme un blocage (`runaway`), une ligne par minute au plus.
   */
  private watchForHeadAway(now: number, delta: number): boolean {
    const intent = this.seekState.intent;
    if (intent) {
      if (this.seekState.requested !== null || seekArrived(now, intent.target)) return false;
      this.seekState.drop();
      this.headAway(`saut parti ailleurs : visé ${intent.target.toFixed(1)} s, tête à ${now.toFixed(1)} s — on y retourne`, now, intent.target, {
        seekTarget: intent.target,
        stalledMs: Date.now() - intent.since,
      });
      return true;
    }
    // Une ouverture en attente de son média, ou un saut en cours : la tête est hors du média
    // par construction, et ce n'est pas elle qui avance.
    if (this.pendingStart !== null || this.video.seeking || this.isBufferedAt(now)) {
      this.runawaySeconds = 0;
      return false;
    }
    if (delta <= 0 || delta > 5) return false;
    const before = this.runawaySeconds;
    this.runawaySeconds += delta;
    if (before >= RUNAWAY_REPORT_SECONDS || this.runawaySeconds < RUNAWAY_REPORT_SECONDS) return false;
    this.headAway(`horloge qui avance sans média : ${this.runawaySeconds.toFixed(1)} s courues jusqu'à ${now.toFixed(2)} s`, now, now, { stalledMs: 0 });
    return true;
  }

  /** Écrit, puis renvoie la tête par l'échelle des reprises. */
  private headAway(what: string, now: number, target: number, facts: { seekTarget?: number; stalledMs: number }): void {
    trace(`${what} — ${this.elementState()}`);
    if (Date.now() - this.lastStallReportAt >= STALL_REPORT_COOLDOWN_MS) {
      this.lastStallReportAt = Date.now();
      try {
        // `runaway` en tête : `clean()` borne le nombre de champs, et c'est lui qui distingue la ligne.
        const { stalledMs, ...rest } = facts;
        this.callbacks.onStall?.({ runaway: true, ...rest, ...this.stallReport(now, stalledMs) });
      } catch {
        /* the log is not worth a player */
      }
    }
    // Vers la cible, là aussi : c'est de là que l'hôte reconstruira, et non de l'endroit où la
    // tête s'est enfuie (audit du 22/09/2026).
    if (!this.recover(target)) this.handOver(target);
  }

  /**
   * What a stall line carries: one level deep and short, for `clean()` in playerLog.ts, which keeps
   * 24 fields — with the file's own six and the path, this leaves room and no more.
   */
  private stallReport(now: number, stalledMs: number): Record<string, unknown> {
    const managed = (this.source as ManagedMediaSource).streaming;
    return {
      position: now,
      stalledMs,
      readyState: this.video.readyState,
      networkState: this.video.networkState,
      seeking: this.video.seeking,
      source: this.source.readyState,
      videoBuffered: this.spansNear(this.videoBuffer, now),
      audioBuffered: this.audioBuffer ? this.spansNear(this.audioBuffer, now) : "aucun",
      lead: Math.round(this.lead * 100) / 100,
      filling: this.fillTask !== null,
      recoveryStreak: this.recoveryStreak,
      frozenNudges: this.frozenNudges,
      recoveries: this.recoveries,
      sinceAppendMs: Date.now() - this.lastAppendAt,
      // Only ManagedMediaSource has the signal; plain MediaSource says so rather than `true`.
      streaming: typeof managed === "boolean" ? managed : "sans objet",
      steps: traceRecent(STALL_TRACE_MS).join(" | "),
    };
  }

  /** One buffer's ranges within half a minute of the head, written short. Never throws. */
  private spansNear(buffer: SourceBuffer | null, at: number): string {
    try {
      const ranges = buffer?.buffered;
      if (!ranges || ranges.length === 0) return "vide";
      const spans: string[] = [];
      for (let i = 0; i < ranges.length && spans.length < 4; i++) {
        if (ranges.end(i) < at - 30 || ranges.start(i) > at + 30) continue;
        spans.push(`${ranges.start(i).toFixed(2)}–${ranges.end(i).toFixed(2)}`);
      }
      return spans.join(" · ") || "rien près de la tête";
    } catch {
      return "illisible (source fermée)";
    }
  }

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
    if (Date.now() - this.frozenSince < (this.video.seeking ? FROZEN_SEEKING_MS : FROZEN_CLOCK_MS)) return;
    // Only when there is plainly something to play: a clock that is not moving because the
    // buffer ran dry is an ordinary wait, and the fill loop is already on it.
    if (this.lead < 1) return;
    this.frozenSince = Date.now();
    if (this.frozenNudges >= MAX_FROZEN_NUDGES) {
      // Three pushes did not free it. This used to be the end of it — `return`, for as long as
      // the clock stayed put, which is to say for ever. Now it is the start of the recovery
      // ladder: the position asked for again the heavy way, buffers cleared and read afresh,
      // then the next keyframe, then a rebuild. Paced by `frozenSince`, once per 1.5 s at most.
      trace(`horloge figée à ${now.toFixed(2)} s malgré ${this.frozenNudges} poussées — reprise`);
      if (!this.recover(now + FROZEN_STEP)) this.handOver(now);
      return;
    }

    this.frozenNudges += 1;
    this.frozenNudgesTotal += 1;
    trace(`horloge figée à ${now.toFixed(2)} s avec ${this.lead.toFixed(1)} s en avance — on redemande la position`);
    this.guard.forgetPause();
    this.video.currentTime = now + FROZEN_STEP;
    // Le mouvement se mesure depuis là où la poussée a mis l'horloge. Mesuré depuis `now`, les
    // 0,08 s de la poussée passaient pour de la lecture et remettaient le compteur à zéro : douze
    // poussées sur 1917, jamais une reprise.
    this.lastClockAt = now + FROZEN_STEP;
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
    //
    // Measured from the last attempt that *went ahead*, never from the last call. It was
    // refreshed on every call, abandoned ones included, and the watchdog calls every 250 ms: the
    // window never ran out, and after the third attempt every later call gave up — the same latch
    // this was written to remove, reached by another road (22/09/2026, a clock held at 166 s for
    // nineteen seconds with nothing trying anything).
    if (Date.now() - this.lastRecoveryAt > RECOVERY_WINDOW_MS) this.recoveryStreak = 0;

    const sameSpot = Math.abs(target - this.recoveryTarget) < 1;
    if ((sameSpot && this.recoveryStreak >= MAX_RECOVERY_ATTEMPTS) || this.unplayedAttempts >= MAX_UNPLAYED_ATTEMPTS) {
      return this.escalate(target);
    }
    if (sameSpot) this.recoveryStreak += 1;
    else {
      this.recoveryTarget = target;
      this.recoveryStreak = 1;
    }
    this.attempt(target, `reprise ${this.recoveryStreak}`);
    return true;
  }

  /** One recovery seek, counted everywhere it has to be. */
  private attempt(target: number, because: string): void {
    this.lastRecoveryAt = Date.now();
    this.recoveries += 1;
    this.unplayedAttempts += 1;
    this.playedSinceTrouble = 0;
    void this.seek(target, because);
  }

  /**
   * Asking for the same spot again has not helped: the next rung, or false when none is left.
   *
   * Giving up used to be the last word — traced, and then nothing, for as long as the viewer
   * waited. The rungs, each tried once until the clock has really played again:
   *
   * 1. **The next keyframe past the head.** The same position re-read is the same group of
   *    pictures decoded the same way; an open-GOP keyframe ten seconds on is a group nothing has
   *    touched. A viewer loses a few seconds rather than the film.
   * 2. **Nothing more here** — false, and the caller hands over (`handOver`) so the host rebuilds
   *    the whole pipeline at the head, within its own budget.
   *
   * Still traced rather than shown, as the abandon always was: the remuxer's own index back-up
   * regularly lands a position a moment after the source has given up on it, and a banner
   * announced a failure to a viewer whose film was about to carry on.
   */
  private escalate(target: number): boolean {
    if (this.escalation >= 1) return false;
    this.escalation = 1;
    this.escalations += 1;
    trace(`reprise abandonnée après ${this.recoveryStreak} tentatives vers ${target.toFixed(1)} s`);
    const next = this.nextKeyframeAfter(target);
    if (next === null) return false;
    trace(`reprise : image clé suivante, ${next.toFixed(1)} s`);
    // Counted as the first attempt at the new spot, so it too gets three before the last rung.
    this.recoveryTarget = next;
    this.recoveryStreak = 1;
    this.attempt(next, "reprise : image clé suivante");
    return true;
  }

  /**
   * The next indexed keyframe on the player's clock, far enough past `target` to be a different
   * group, or null. Never throws: this runs on the path that is already failing.
   */
  private nextKeyframeAfter(target: number): number | null {
    try {
      if (!this.remuxer.seekable) return null;
      // Half a second on, so a head standing right on a keyframe does not pick that same one.
      const fileSeconds = this.remuxer.keyframeAfter(Math.max(0, target - this.delaySeconds) + 0.5);
      if (fileSeconds === null) return null;
      const end = this.plan.durationSeconds > 0 ? this.plan.durationSeconds + this.delaySeconds : Infinity;
      const next = fileSeconds + this.delaySeconds + NEXT_KEYFRAME_MARGIN;
      return next < end - 1 ? next : null;
    } catch {
      return null;
    }
  }

  /**
   * The last rung: this source has nothing left to try, and says so the way a lost source does.
   *
   * Through `onError` and `lost`, the host's existing answer to a source it must build again — not
   * a parallel mechanism: its budget (three in three minutes) and its step past a place that has
   * already failed twice apply unchanged, and past that budget it hands the film to the stable
   * player. Once only; the watchdog stands down behind `stuck`.
   */
  private handOver(at: number): void {
    if (this.stuck || this.destroyed) return;
    this.stuck = true;
    this.handedOverAt = at;
    this.escalation = 2;
    this.escalations += 1;
    trace(`reprise impossible ici à ${at.toFixed(1)} s — reconstruction demandée ${this.elementState()}`);
    this.callbacks.onError(
      `lecture bloquée à ${at.toFixed(1)} s après ${this.recoveries} reprises ${this.elementState()}`,
      "playback"
    );
  }

  /**
   * Un saut en cours, selon la source : demandé et pas encore servi, ou servi et pas encore arrivé.
   * L'hôte le lit pour savoir quand oublier la cible qu'il a demandée — la source peut l'avoir
   * posée ailleurs (premier média, image clé suivante), et c'est elle qui sait si c'est fini.
   */
  get seekPending(): boolean {
    return this.seekState.pending;
  }

  /** What the `stop` line wants to know of the recoveries over the whole session. */
  get recoveryFacts(): { recoveries: number; frozenNudges: number; escalations: number } {
    return { recoveries: this.recoveries, frozenNudges: this.frozenNudgesTotal, escalations: this.escalations };
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
    // Or this source has handed over (`handOver`): open, but nothing left to try. The same answer
    // fits — build again at the head — and the host already knows how to give it.
    return !this.destroyed && (this.stuck || this.source.readyState === "closed");
  }

  /** Where the viewer was, for a caller that has to rebuild and wants to come back to it. */
  /**
   * Où le film en est — et, une fois la main passée à l'hôte, où il doit reprendre : la position
   * donnée à `handOver`, qui peut être la cible d'un saut parti ailleurs plutôt que la tête.
   */
  get position(): number {
    return this.stuck && this.handedOverAt !== null ? this.handedOverAt : this.video.currentTime;
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
    this.video.removeEventListener("seeked", this.onSeeked);
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
    // L'attribut part AVANT la révocation, et hors du `catch`. Ordre **inverse** de celui de la
    // sonde de `codecSupport.ts:78-80`, qui révoque puis retire — et c'est délibéré des deux
    // côtés : ce qui compte n'est pas l'ordre en soi, c'est ce qui, entre les deux gestes, peut
    // relancer la sélection de ressource. La sonde n'écrit jamais `srcObject`, rien ne la relance
    // donc entre sa révocation et son retrait, et son `load()` final tombe sur un élément déjà
    // vidé — d'ailleurs jeté juste après. Ici, si. Écrire `srcObject`, *y compris avec `null`*,
    // relance l'algorithme de chargement de l'élément ; ne trouvant plus de `srcObject`, la
    // sélection de ressource retombe sur l'attribut `src`. Révoquer d'abord envoyait donc
    // l'élément chercher l'URL qu'on venait de tuer, et Chrome le disait dans la console à
    // chaque fermeture : `GET blob:… net::ERR_FILE_NOT_FOUND`. Pire, le retrait vivait dans un
    // `catch` qui ne s'exécutait jamais là où il servait : Chrome refuse `srcObject = MediaSource`
    // — c'est pourquoi il prend la branche à URL — mais accepte `srcObject = null` sans broncher.
    // L'élément restait donc avec un `src` pointant sur un blob mort, et l'échec de chargement
    // levait un `error` qui pouvait atterrir sur la session suivante, laquelle réutilise le même
    // élément.
    this.video.removeAttribute("src");
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    try {
      // Suffit à remettre l'élément à zéro : le setter relance l'algorithme de chargement, qui ne
      // trouve alors plus rien à charger. Pas de `load()` derrière, contrairement à la sonde, qui
      // n'écrit jamais `srcObject` et n'a que lui pour interrompre le chargement en cours.
      (this.video as unknown as { srcObject: unknown }).srcObject = null;
    } catch {
      // Un élément qui refuse jusqu'à `null` n'a rien relancé, mais son `src` est déjà parti
      // ci-dessus : il ne reste rien à défaire ici.
    }
  }
}
