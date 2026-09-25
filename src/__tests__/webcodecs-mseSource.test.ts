// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MseSource, playabilityOf } from "@/lib/webcodecs/mseSource";
import type { Remuxer, RemuxPlan, RemuxSegment } from "@/lib/webcodecs/remuxer";
import { traceReset, traceText } from "@/lib/webcodecs/trace";

// MediaSource does not exist in jsdom, and the parts of it that matter here — when a buffer
// signals it is done, when the system asks for data, what happens when it is full — are exactly
// the parts a real browser would only exercise on a device. So they are modelled explicitly.

class FakeBuffer extends EventTarget {
  mode = "sequence";
  updating = false;
  appended: Uint8Array[] = [];
  removed: [number, number][] = [];
  aborted = 0;
  /** Set to make appends land without ever covering the playhead. */
  coversNothing = false;
  /** How far past the point it was pointed at this buffer's media actually begins. */
  landsLate = 0;
  /**
   * Où commence le média, quand ce n'est pas sous la tête.
   *
   * Une ouverture en cours de film envoie son média avant de déplacer la tête : le lecteur est
   * pointé sur 1200 s pendant que la tête est encore à zéro. Ce modèle faisait naître toute
   * nouvelle plage sous la tête, ce qui était vrai tant que la tête y était déjà — et qui rendait
   * l'état d'une reprise impossible à écrire ici.
   */
  mediaStartsAt: number | null = null;
  /** Set to make the next append throw as a full buffer does. */
  quotaOnNextAppend = false;
  /** Set to make the next append fail the way a segment the decoder rejects does. */
  failOnNextAppend = false;
  /** Set to make every append fail, for the case where retrying cannot help. */
  failAllAppends = false;
  /** Each media segment carries this much, so the buffer grows as it would in a browser. */
  secondsPerAppend = 2;
  /** An initialisation segment carries no media, so it adds no buffered range. */
  private initSeen = false;
  /**
   * How long an operation holds the buffer. A real one takes milliseconds of parsing, and that
   * window is the only place a second operation can collide with it; the default keeps the
   * other tests on microtasks so they stay fast.
   */
  busyMs = 0;

  private finishSoon() {
    const done = () => {
      this.updating = false;
      if (this.failOnNextAppend || this.failAllAppends) {
        this.failOnNextAppend = false;
        this.dispatchEvent(new Event("error"));
      } else {
        this.dispatchEvent(new Event("updateend"));
      }
    };
    if (this.busyMs > 0) setTimeout(done, this.busyMs);
    else queueMicrotask(done);
  }
  private ranges: [number, number][] = [];

  /**
   * Un tampon de ManagedMediaSource : il a `onbufferedchange`, et dit chaque plage retirée — par
   * la page comme par le système. Les tests qui l'écoutent l'allument ; les autres restent des
   * tampons de MediaSource ordinaire, sans l'événement.
   */
  static managed = false;

  constructor(readonly type: string) {
    super();
    if (FakeBuffer.managed) Object.assign(this, { onbufferedchange: null });
  }

  private announceRemoved(removed: [number, number][]) {
    if (!("onbufferedchange" in this) || removed.length === 0) return;
    const ranges = {
      length: removed.length,
      start: (i: number) => removed[i][0],
      end: (i: number) => removed[i][1],
    } as unknown as TimeRanges;
    this.dispatchEvent(Object.assign(new Event("bufferedchange"), { addedRanges: { length: 0 }, removedRanges: ranges }));
  }

  /** Ce que fait Safari quand la mémoire manque : retirer une plage, sans qu'on le lui demande. */
  systemEvicts(start: number, end: number) {
    const kept: [number, number][] = [];
    for (const [s, e] of this.ranges) {
      if (e <= start || s >= end) kept.push([s, e]);
      else {
        if (s < start) kept.push([s, start]);
        if (e > end) kept.push([end, e]);
      }
    }
    this.ranges = kept;
    this.announceRemoved([[start, end]]);
  }

  get buffered() {
    const ranges = this.ranges;
    return {
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    } as unknown as TimeRanges;
  }

  /** Pretends the appended media covers this span, which is what drives the fill loop's decision. */
  setBuffered(start: number, end: number) {
    this.ranges = end > start ? [[start, end]] : [];
  }

  /** Several disjoint spans, as a browser reports after a seek away and back. */
  setRanges(ranges: [number, number][]) {
    this.ranges = ranges;
  }

  /** A real SourceBuffer permits one operation at a time and throws otherwise. */
  private refuseIfBusy(what: string) {
    if (this.updating) throw new DOMException(`${what} while updating`, "InvalidStateError");
  }

  appendBuffer(data: Uint8Array) {
    this.refuseIfBusy("appendBuffer");
    if (this.quotaOnNextAppend) {
      this.quotaOnNextAppend = false;
      throw new DOMException("full", "QuotaExceededError");
    }
    this.appended.push(data);
    this.updating = true;
    // A real buffer does not always cover the playhead the instant it is fed: the sound of a
    // newly chosen track arrives a little ahead of where the viewer is, and until it lands the
    // element's ranges — the intersection of the two buffers — hold nothing at all.
    if (this.coversNothing) {
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      });
      return;
    }
    // A buffer that always reports itself empty would let the fill loop run away; growing it is
    // what makes "stop once far enough ahead" testable at all. A fresh range begins wherever the
    // reader was pointed, exactly as a real one does — starting every range at zero would mean
    // media never reached a seeked-to playhead, and the model would loop rather than the code.
    if (this.initSeen) {
      const here = this.mediaStartsAt ?? mediaStartsAtDefault ?? playheadOf();
      const start = this.ranges.length > 0 ? this.ranges[0][0] : here + this.landsLate;
      const end = (this.ranges.length > 0 ? this.ranges[0][1] : here + this.landsLate) + this.secondsPerAppend;
      this.ranges = [[start, end]];
    }
    this.initSeen = true;
    this.finishSoon();
  }

  remove(start: number, end: number) {
    this.refuseIfBusy("remove");
    this.removed.push([start, end]);
    const had = this.ranges;
    this.ranges = [];
    this.updating = true;
    // Annoncé pendant l'opération, avant `updateend`, comme le fait l'algorithme de retrait.
    this.announceRemoved(had.map(([s, e]) => [Math.max(s, start), Math.min(e, end)] as [number, number]).filter(([s, e]) => e > s));
    if (this.busyMs > 0) {
      setTimeout(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      }, this.busyMs);
    } else {
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event("updateend"));
      });
    }
  }

  abort() {
    this.aborted += 1;
  }

  changeType() {
    this.refuseIfBusy("changeType");
    this.typeChangedAfter = this.removed.length;
  }
  /** How many removals had happened by the time the codec was changed. */
  typeChangedAfter = -1;
}

class FakeSource extends EventTarget {
  static supported = new Set<string>();
  static instances: FakeSource[] = [];
  static isTypeSupported(type: string) {
    return FakeSource.supported.has(type);
  }
  readyState: "closed" | "open" | "ended" = "closed";
  duration = NaN;
  streaming = true;
  endedTimes = 0;
  buffers: FakeBuffer[] = [];

  constructor() {
    super();
    FakeSource.instances.push(this);
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
  removed: FakeBuffer[] = [];
  addSourceBuffer(type: string) {
    const buffer = new FakeBuffer(type);
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }
  removeSourceBuffer(buffer: SourceBuffer) {
    this.removed.push(buffer as unknown as FakeBuffer);
  }
  endOfStream() {
    this.endedTimes += 1;
    this.readyState = "ended";
  }
}

/**
 * La tête de lecture de l'élément le plus récemment créé.
 *
 * Elle a longtemps été une simple variable de module, partagée par tous les éléments simulés du
 * fichier — et c'est ce qui rendait « la reprise repart où le son s'est arrêté » instable une
 * fois sur six : une source d'un test précédent, jamais fermée, continuait sa boucle de lecture
 * et poussait *sa* tête de lecture, dont l'écriture atterrissait dans cette variable, c'est-à-dire
 * dans l'élément du test en cours. Avec cinq cents segments derrière elle, elle y écrivait des
 * valeurs comme 600 s.
 *
 * Chaque élément garde donc désormais la sienne, en fermeture ; seule la lecture — ce dont le
 * modèle de tampon a besoin pour savoir où commencer une plage — passe encore par ici, et
 * désigne le dernier élément créé, c'est-à-dire celui du test en cours.
 */
let playheadOf: () => number = () => 0;
/**
 * Où naît le média quand ce n'est pas sous la tête, pour les tampons pas encore créés.
 *
 * Le modèle prenait la tête pour le lecteur, ce qui était vrai tant que l'ouverture d'un film
 * en cours de route posait la tête tout de suite. Elle attend maintenant que le média la couvre
 * (voir `pendingStart`), et sans cette distinction le banc ne peut pas écrire l'état d'une
 * reprise : celui où le lecteur travaille à 1200 s pendant que la tête est encore à zéro.
 */
let mediaStartsAtDefault: number | null = null;

/** The intersection of every buffer's ranges, which is what a media element reports. */
function intersectionOfBuffers(): TimeRanges {
  const buffers = FakeSource.instances[0]?.buffers ?? [];
  const lists = buffers.map((b) => b.buffered);
  // A track with nothing in it empties the intersection rather than being left out of it: an
  // element plays nowhere if any of its tracks has no media there.
  if (lists.length === 0 || lists.some((r) => r.length === 0)) return { length: 0 } as unknown as TimeRanges;
  let ranges: [number, number][] = [];
  for (let i = 0; i < lists[0].length; i++) ranges.push([lists[0].start(i), lists[0].end(i)]);
  for (const other of lists.slice(1)) {
    const next: [number, number][] = [];
    for (const [s, e] of ranges) {
      for (let i = 0; i < other.length; i++) {
        const start = Math.max(s, other.start(i));
        const end = Math.min(e, other.end(i));
        if (end > start) next.push([start, end]);
      }
    }
    ranges = next;
  }
  return { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] } as unknown as TimeRanges;
}

function fakeVideo() {
  // Propre à cet élément : une horloge poussée par une source oubliée n'atteint plus les autres.
  let playhead = 0;
  playheadOf = () => playhead;
  const target = new EventTarget();
  Object.defineProperty(target, "buffered", { get: intersectionOfBuffers, configurable: true });
  Object.defineProperty(target, "currentTime", {
    get: () => playhead,
    set: (v: number) => {
      playhead = v;
    },
    configurable: true,
  });
  return Object.assign(target, {
    paused: false,
    // The two the hold uses. Recorded rather than simulated: what matters is whether the element
    // was told to stop and whether it was told to start again.
    pause: vi.fn(function (this: { paused: boolean }) {
      this.paused = true;
    }),
    play: vi.fn(function (this: { paused: boolean }) {
      this.paused = false;
      return Promise.resolve();
    }),
    disableRemotePlayback: false,
    srcObject: null as unknown,
    src: "",
    removeAttribute: () => {},
  }) as unknown as HTMLVideoElement;
}

const PLAN: RemuxPlan = {
  videoMimeType: 'video/mp4; codecs="hvc1.2.4.L150.90"',
  audioMimeType: 'audio/mp4; codecs="ec-3"',
  videoInit: new Uint8Array([1]),
  audioInit: new Uint8Array([2]),
  durationSeconds: 3600,
};

function fakeRemuxer(segments: number, delay = 0.2, seekable = true, readMs = 0) {
  let index = 0;
  const seeks: number[] = [];
  const remuxer = {
    seeks,
    seekable,
    plan: () => PLAN,
    diagnostics: () => ({ presentationDelaySeconds: delay, clampedSamples: 0 }),
    seekTo: (s: number) => {
      seeks.push(s);
      index = 0;
    },
    nextSegment: async (): Promise<RemuxSegment | null> => {
      // Reading takes time in reality, which is what leaves the read loop mid-append while
      // something else reaches for the same buffer.
      if (readMs) await new Promise((r) => setTimeout(r, readMs));
      if (index >= segments) return null;
      index += 1;
      // Every segment carries a line, read out of the same stretch of file as the pictures.
      const subtitles = [
        { track: 4, startSeconds: index * 2, endSeconds: index * 2 + 1.5, text: `ligne ${index}` },
      ];
      return {
        video: [new Uint8Array([10 + index])],
        audio: new Uint8Array([20 + index]),
        subtitles,
        endSeconds: index * 2,
      };
    },
  };
  return remuxer as unknown as Remuxer & { seeks: number[] };
}

beforeEach(() => {
  FakeBuffer.managed = false;
  playheadOf = () => 0;
  mediaStartsAtDefault = null;
  FakeSource.instances = [];
  FakeSource.supported = new Set([PLAN.videoMimeType, PLAN.audioMimeType!]);
  vi.stubGlobal("ManagedMediaSource", FakeSource);
  vi.stubGlobal("MediaSource", FakeSource);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Waits for something to become true rather than for a fixed stretch of time.
 *
 * A read loop under load takes as long as it takes: a sleep long enough on an idle machine is a
 * coin toss on a busy one, and a flaky test here blocks the image build. Fails loudly on the
 * deadline so a real regression still reads as a failure and not as a hang.
 */
async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Toujours faux après ${timeoutMs} ms : ${what}`);
}

describe("playabilityOf", () => {
  it("accepts a plan whose codecs the browser declares", () => {
    expect(playabilityOf(PLAN)).toEqual({ ok: true });
  });

  // The whole point of this path is that a refusal is visible. A player that silently drops to a
  // slower route leaves you unable to tell a path that works from one that was never taken.
  it("names the codec it cannot play instead of failing quietly", () => {
    FakeSource.supported = new Set([PLAN.audioMimeType!]);
    const video = playabilityOf(PLAN);
    expect(video.ok).toBe(false);
    expect(video.ok === false && video.reason).toContain("hvc1.2.4.L150.90");

    FakeSource.supported = new Set([PLAN.videoMimeType]);
    const audio = playabilityOf(PLAN);
    expect(audio.ok).toBe(false);
    expect(audio.ok === false && audio.reason).toContain("ec-3");
  });

  it("refuses outright where MediaSource does not exist at all", () => {
    vi.stubGlobal("ManagedMediaSource", undefined);
    vi.stubGlobal("MediaSource", undefined);
    expect(playabilityOf(PLAN)).toEqual({ ok: false, reason: "Ce navigateur ne propose pas MediaSource." });
  });
});

describe("MseSource", () => {
  it("sends each track's initialisation segment before any media of that track", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    await MseSource.attach(video, fakeRemuxer(2), PLAN, { onError });
    await flush();

    const source = FakeSource.instances[0];
    const [videoBuffer, audioBuffer] = source.buffers;
    expect(videoBuffer.type).toBe(PLAN.videoMimeType);
    expect(Array.from(videoBuffer.appended[0])).toEqual([1]);
    expect(Array.from(audioBuffer.appended[0])).toEqual([2]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("required by Safari before a managed source will attach: remote playback is turned off", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(1), PLAN, { onError: vi.fn() });
    expect(video.disableRemotePlayback).toBe(true);
  });

  it("stops fetching once enough is buffered ahead of the playhead", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(100), PLAN, { onError: vi.fn() });
    await flush();
    const buffer = FakeSource.instances[0].buffers[0];
    // Two seconds per segment against a thirty-second target: it must stop well short of the
    // hundred available, or a two-hour film would be pulled into memory in one go.
    expect(buffer.buffered.end(0)).toBeGreaterThanOrEqual(30);
    expect(buffer.appended.length).toBeLessThan(20);
  });

  it("resumes fetching as the playhead advances into what is buffered", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(100), PLAN, { onError: vi.fn() });
    await flush();
    const buffer = FakeSource.instances[0].buffers[0];
    const atRest = buffer.appended.length;

    (video as unknown as { currentTime: number }).currentTime = 25;
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(buffer.appended.length).toBeGreaterThan(atRest);
  });

  it("declares the media as ending later than the file, by the presentation delay", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(1, 0.25), PLAN, { onError: vi.fn() });
    await flush();
    expect(FakeSource.instances[0].duration).toBe(3600.25);
  });

  it("ends the stream when the file runs out, exactly once", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(2), PLAN, { onError: vi.fn() });
    await flush();
    const source = FakeSource.instances[0];
    expect(source.endedTimes).toBe(1);
    source.dispatchEvent(new Event("startstreaming"));
    await flush();
    expect(source.endedTimes).toBe(1);
  });

  it("takes the presentation delay off a seek, because the file's clock is behind the player's", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(50, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();

    await mse.seek(600);
    // The remuxer works on the file's clock. Seeking it to the player's time would land a fifth
    // of a second late on every seek — small, constant, and exactly the kind of error that is
    // never noticed until someone compares a subtitle to the sound.
    expect(remuxer.seeks).toEqual([599.8]);
    expect(video.currentTime).toBe(600);
  });

  it("never asks the file for a negative time, however early the seek", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(50, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    await mse.seek(0.05);
    expect(remuxer.seeks).toEqual([0]);
  });

  it("clears both buffers on a seek so the old media cannot be played back", async () => {
    const video = fakeVideo();
    const mse = await MseSource.attach(video, fakeRemuxer(50), PLAN, { onError: vi.fn() });
    await flush();
    const [videoBuffer, audioBuffer] = FakeSource.instances[0].buffers;
    videoBuffer.setBuffered(0, 20);
    audioBuffer.setBuffered(0, 20);

    await mse.seek(600);
    expect(videoBuffer.removed[0][0]).toBe(0);
    expect(videoBuffer.removed[0][1]).toBeGreaterThan(PLAN.durationSeconds);
    expect(audioBuffer.removed[0][0]).toBe(0);
  });

  it("drops played media when the buffer is full rather than reporting a failure", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    const remuxer = fakeRemuxer(200);
    await MseSource.attach(video, remuxer, PLAN, { onError });
    await flush();

    const buffer = FakeSource.instances[0].buffers[0];
    (video as unknown as { currentTime: number }).currentTime = 100;
    buffer.setBuffered(0, 110);
    buffer.quotaOnNextAppend = true;
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    await flush();

    // A full buffer is a condition to manage, not a fault to surface.
    expect(onError).not.toHaveBeenCalled();
    expect(buffer.removed.some(([start, end]) => start === 0 && end === 70)).toBe(true);
    // Et le segment refusé est redemandé, depuis la tête : il était perdu, et le tampon gardait un
    // trou que la lecture trouvait plus tard (relu le 23/09/2026).
    expect(remuxer.seeks.length).toBeGreaterThan(0);
  });

  /**
   * Une piste audio qui s'arrête avant l'image n'est pas un navigateur qui ne retient rien.
   *
   * La profondeur jouable est l'intersection des deux tampons : le son fini, elle ne grandit plus,
   * et huit segments plus tard la boucle déclarait le navigateur défaillant — le film était
   * reconstruit au lieu de finir (relu le 23/09/2026).
   */
  it("continue de remplir quand seule l'image avance encore", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    const remuxer = fakeRemuxer(40);
    await MseSource.attach(video, remuxer, PLAN, { onError });
    FakeSource.instances[0].buffers[1].secondsPerAppend = 0;
    for (let i = 0; i < 10; i++) await flush();

    expect(onError).not.toHaveBeenCalled();
    expect(remuxer.seeks).toEqual([]);
  });

  it("recovers from a rejected segment instead of declaring playback over", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    const onWarning = vi.fn();
    const remuxer = fakeRemuxer(200);
    await MseSource.attach(video, remuxer, PLAN, { onError, onWarning });
    await flush();

    const buffer = FakeSource.instances[0].buffers[0];
    buffer.failOnNextAppend = true;
    (video as unknown as { currentTime: number }).currentTime = 30;
    video.dispatchEvent(new Event("timeupdate"));
    await flush();

    // Reported from a device as a freeze that a second seek undid — so nothing was lost, and
    // ending playback was the wrong answer to a segment that simply needed sending again.
    expect(onError).not.toHaveBeenCalled();
    expect(remuxer.seeks.length).toBeGreaterThan(0);
    // And the viewer is not told: they saw nothing, because it was fixed before they could. A
    // banner here interrupts somebody about a problem that no longer exists — it goes to the
    // record instead, which is where the technical panel reads it from.
    expect(onWarning).not.toHaveBeenCalled();
    expect(traceText()).toContain("segment refusé, repris");
  });

  it("pousses a clock that has stopped while media sits in front of it", async () => {
    // The stall nothing could see: the element reports itself as playing, the playhead is on the
    // media, twenty seconds are buffered ahead — and the clock does not move. Reported from a
    // phone, on an episode opened from the beginning, frozen at 0:00. Every other check here
    // watches for a playhead standing on nothing, which this is the opposite of.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(200);
    const source = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();

    (video as unknown as { currentTime: number }).currentTime = 0.25;
    const before = video.currentTime;
    const frozen = source as unknown as { watchForFrozenClock: (at: number) => void; frozenSince: number | null };

    // And a resume is movement: an element just given back to the viewer is never pushed.
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    frozen.watchForFrozenClock(before);
    expect(frozen.frozenSince).not.toBeNull();

    // Seen once: noted, not acted on. A clock that has just stopped is not a stall.
    frozen.watchForFrozenClock(before);
    expect(video.currentTime).toBe(before);

    // Still there a second and a half later, with media in front of it: pushed.
    frozen.frozenSince = Date.now() - 5000;
    frozen.watchForFrozenClock(before);
    expect(video.currentTime).toBeGreaterThan(before);
  });

  it("baisse sa cible quand le navigateur refuse, au lieu de jeter des segments en silence", async () => {
    // Refused media used to be dropped and nothing more. That works while there is something
    // behind the playhead to free — and in the first half-minute of a film there never is, so
    // every segment was refused, dropped, and after eight of them the loop concluded the browser
    // was keeping nothing at all. The cause and the diagnosis had nothing to do with each other.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    const source = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();

    const inner = source as unknown as { targetBuffer: number; quotaHit: () => void; lead: number };
    expect(inner.targetBuffer).toBe(30);
    inner.quotaHit();

    expect(inner.targetBuffer).toBeLessThan(30);
    // Never below the floor the film needs to play at all.
    expect(inner.targetBuffer).toBeGreaterThanOrEqual(8);
  });

  it("garde sa cible quand le refus arrive sans rien devant la tête", async () => {
    // Mac, 24/09/2026 : « tampon plein à 0.0 s : on vise 8 s pour ce fichier ». Une avance nulle au
    // moment du refus ne mesure pas ce que le navigateur peut tenir, et le film finissait à 8 s.
    const video = fakeVideo();
    const source = await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn() });
    await flush();
    const inner = source as unknown as { targetBuffer: number; quotaHit: () => void };
    Object.defineProperty(inner, "lead", { get: () => 0, configurable: true });
    traceReset();
    inner.quotaHit();
    expect(inner.targetBuffer).toBe(30);
    expect(traceText()).toContain("cible gardée à 30 s");
  });

  describe("budget en octets selon le moteur (25/09/2026)", () => {
    const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15";
    afterEach(() => {
      vi.restoreAllMocks();
      Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
    });

    /** Un remultiplexeur 4K : chaque segment de 2 s pèse 8 Mo d'image, 32 Mb/s. */
    function heavyRemuxer(segments: number) {
      const remuxer = fakeRemuxer(segments);
      const next = remuxer.nextSegment.bind(remuxer);
      remuxer.nextSegment = async () => {
        const segment = await next();
        if (!segment) return segment;
        const picture = new Uint8Array(1);
        Object.defineProperty(picture, "byteLength", { value: 8e6 });
        return { ...segment, video: [picture] };
      };
      return remuxer;
    }

    it("sur un iPad, vise moins de trente secondes d'avance en 4K, et l'écrit", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPAD);
      Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
      traceReset();
      const video = fakeVideo();
      await MseSource.attach(video, heavyRemuxer(200), PLAN, { onError: vi.fn() });
      await until(() => traceText().includes("budget WebKit mobile"), "le budget écrit dans la trace");
      await new Promise((r) => setTimeout(r, 50));
      // 105 Mo à 4 Mo/s : ~26 s en tout. L'avance s'arrête bien avant les trente secondes.
      expect(video.buffered.end(0)).toBeLessThan(24);
      expect(traceText()).toMatch(/budget WebKit mobile : 110 Mo d'image, 6 Mo de son/);
    });

    it("retire lui-même ce qui dépasse derrière la tête, au lieu de le laisser à Safari", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPAD);
      Object.defineProperty(navigator, "maxTouchPoints", { value: 5, configurable: true });
      const video = fakeVideo();
      await MseSource.attach(video, heavyRemuxer(200), PLAN, { onError: vi.fn() });
      await until(() => video.buffered.length > 0 && video.buffered.end(0) > 12, "du média chargé");
      const [videoBuffer] = FakeSource.instances[0].buffers;
      // La lecture avance de 30 s : tout ce qui précède 30 s moins le budget arrière est de trop.
      (video as unknown as { currentTime: number }).currentTime = 30;
      videoBuffer.setBuffered(0, 36);
      video.dispatchEvent(new Event("timeupdate"));
      await until(() => videoBuffer.removed.some(([s, e]) => s === 0 && e > 15 && e < 30), "un retrait derrière la tête");
    });

    it("sur Chrome, borne aussi l'avance à ses 150 Mio", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36");
      traceReset();
      const video = fakeVideo();
      await MseSource.attach(video, heavyRemuxer(200), PLAN, { onError: vi.fn() });
      await until(() => traceText().includes("budget Chromium"), "le budget de Chromium écrit dans la trace");
      await new Promise((r) => setTimeout(r, 50));
      // 157 Mo à 4 Mo/s : ~39 s en tout, dont environ 24 devant.
      expect(video.buffered.end(0)).toBeLessThan(28);
      expect(traceText()).toMatch(/budget Chromium : 157 Mo d'image, 13 Mo de son/);
    });

    it("sur Firefox, borne l'avance à ses 150 Mio", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0");
      traceReset();
      const video = fakeVideo();
      await MseSource.attach(video, heavyRemuxer(200), PLAN, { onError: vi.fn() });
      await until(() => traceText().includes("budget Gecko"), "le budget de Gecko écrit dans la trace");
      await new Promise((r) => setTimeout(r, 50));
      expect(video.buffered.end(0)).toBeLessThan(28);
      expect(traceText()).toMatch(/budget Gecko : 157 Mo d'image, 21 Mo de son/);
    });

    it("ne change rien pour un moteur qu'on ne connaît pas", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2; Trident/6.0)");
      traceReset();
      const video = fakeVideo();
      await MseSource.attach(video, heavyRemuxer(200), PLAN, { onError: vi.fn() });
      await until(() => video.buffered.length > 0 && video.buffered.end(0) >= 30, "les trente secondes d'avant");
      expect(traceText()).not.toContain("budget ");
    });
  });

  it("ne touche à rien tant que le navigateur accepte ce qu'on lui donne", async () => {
    // Which is every browser tested here: the cost of the rule above is zero until it is needed.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    const source = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    expect((source as unknown as { targetBuffer: number }).targetBuffer).toBe(30);
  });

  it("stops pretending when the refusals do not let up", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    await MseSource.attach(video, fakeRemuxer(200), PLAN, { onError, onWarning: vi.fn() });
    await flush();

    const buffer = FakeSource.instances[0].buffers[0];
    buffer.failAllAppends = true;
    for (let attempt = 0; attempt < 8; attempt++) {
      (video as unknown as { currentTime: number }).currentTime = 30 + attempt * 100;
      video.dispatchEvent(new Event("timeupdate"));
      await flush();
    }
    // Retrying forever would be its own kind of freeze, quieter than the one it replaced.
    expect(onError).toHaveBeenCalled();
  });

  // The bug this whole group exists for: the transport controls write straight to the element on
  // this path, exactly as they would for any <video>. Without acting on that, the element waits
  // at a time nothing will ever be appended to while the reader grinds forward from where it was.
  it("serves a seek the viewer made on the element itself", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    expect(remuxer.seeks).toEqual([]);

    (video as unknown as { currentTime: number }).currentTime = 1800;
    video.dispatchEvent(new Event("seeking"));
    await flush();

    expect(remuxer.seeks).toEqual([1799.8]);
    expect(FakeSource.instances[0].buffers[0].removed.length).toBeGreaterThan(0);
  });

  it("does no work for a step inside what is already buffered", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    const buffer = FakeSource.instances[0].buffers[0];
    buffer.setBuffered(0, 40);
    buffer.removed.length = 0;

    (video as unknown as { currentTime: number }).currentTime = 12;
    video.dispatchEvent(new Event("seeking"));
    await flush();
    // Re-reading the file to reach media the browser is already holding would turn a free step
    // into a network round trip.
    expect(remuxer.seeks).toEqual([]);
    expect(buffer.removed).toEqual([]);
  });

  it("does not serve its own seek twice", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();

    await mse.seek(900);
    // The element fires seeking in response to that move; acting on it again would clear the
    // buffers currently being refilled.
    video.dispatchEvent(new Event("seeking"));
    await flush();
    expect(remuxer.seeks).toEqual([899.8]);
  });

  it("measures the buffer from the playhead's own range, not the last one left over", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn() });
    await flush();
    const buffer = FakeSource.instances[0].buffers[0];
    const before = buffer.appended.length;

    // What a browser reports after seeking back: a stale span far ahead, and the playhead sitting
    // in front of almost nothing. Measuring against the far one reports a deep buffer and the
    // player quietly stops fetching.
    buffer.setRanges([[100, 101], [900, 940]]);
    (video as unknown as { currentTime: number }).currentTime = 100.5;
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(buffer.appended.length).toBeGreaterThan(before);
  });

  it("refuses a seek a file without an index cannot serve, and says so without stopping", async () => {
    const video = fakeVideo();
    const onWarning = vi.fn();
    const onError = vi.fn();
    const remuxer = fakeRemuxer(500, 0.2, false);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError, onWarning });
    await flush();

    await mse.seek(1800);
    // Starting over from the beginning and reading forward — which is what the fallback did —
    // looks like the player thinking very hard and arriving minutes later.
    expect(remuxer.seeks).toEqual([]);
    expect(onWarning).toHaveBeenCalledWith({ code: "noIndexSeek" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("starts reading where the viewer is resuming, not at the beginning of the file", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    // Le média naît là où le lecteur est pointé, pas sous la tête restée en arrière.
    mediaStartsAtDefault = 1200;
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() }, 1200);
    // Rien n'a encore été envoyé : c'est le seul instant où la tête ne peut pas être posée, et
    // c'est celui que WebKit ne pardonne pas.
    expect(video.currentTime).toBe(0);
    await flush();
    // Filling thirty seconds from zero and then discarding all of it is what made resuming a
    // part-watched episode feel slow.
    expect(remuxer.seeks).toEqual([1200]);
    // Et elle finit par être posée, sur le média qui la couvre — jamais avant qu'il existe.
    expect(video.currentTime).toBeCloseTo(1200, 1);
  });

  it("pose la tête à l'ouverture dès que le média la couvre", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() }, 1200);
    await flush();

    // Les deux pistes, parce qu'un élément ne joue que là où toutes ont du média.
    FakeSource.instances[0].buffers[0].setBuffered(1199, 1230);
    FakeSource.instances[0].buffers[1].setBuffered(1199, 1230);
    video.dispatchEvent(new Event("timeupdate"));
    await flush();

    expect(video.currentTime).toBeCloseTo(1200, 1);
  });

  it("ne prend pas une ouverture différée pour un lecteur égaré", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(2000);
    mediaStartsAtDefault = 1197;
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() }, 1200);
    // L'état exact rapporté par un iPhone : le remultiplexeur ouvre bien à la position demandée,
    // mais le média qu'il produit commence à l'image-clé qui précède et n'a couvert que deux
    // secondes — il ne contient donc pas encore 1200 s. La tête, elle, est restée à zéro : c'est
    // `pendingStart` qui l'y garde tant que le média ne la couvre pas, parce que WebKit ne
    // résout jamais un `seeking` posé sur un tampon vide.
    await flush();

    // Lu comme un lecteur égaré — du média à 1197 s, une tête à 0 — cet écart déclenchait un
    // saut vers la tête, c'est-à-dire vers zéro : on cliquait « Reprendre », et le film repartait
    // du début. Deux fois sur trois, selon la vitesse à laquelle l'élément publie ses plages.
    expect(remuxer.seeks).toEqual([1200]);
    // Et la tête finit par être posée, une fois le média assez long pour la couvrir.
    expect(video.currentTime).toBeCloseTo(1200, 1);
  });

  it("à l'ouverture, pose la tête un pas dans le média qui commence après elle, comme après un saut", async () => {
    // Audit du 22/09/2026 : l'ouverture posait la tête pile au bord du média — ce qui laisse WebKit
    // dans un saut qu'il ne résout pas, déjà corrigé pour les sauts (LANDING_INSET) — et ne
    // l'atteignait qu'à moins d'une seconde, contre quinze après un saut.
    const video = fakeVideo();
    mediaStartsAtDefault = 1200.3;
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn() }, 1200);
    await flush();
    expect(video.currentTime).toBeCloseTo(1200.34, 3);
  });

  it("à l'ouverture, rejoint aussi un média qui commence plusieurs secondes après la position, comme un saut", async () => {
    // Un index creux : le média produit commence 3,5 s après la position demandée. Avant, la tête
    // restait à zéro jusqu'à ce que la détection « rien retenu » s'en mêle.
    const video = fakeVideo();
    mediaStartsAtDefault = 1203.5;
    const remuxer = fakeRemuxer(500);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() }, 1200);
    await flush();
    expect(video.currentTime).toBeCloseTo(1203.54, 3);
    // Directement : pas par une reprise qui relit le fichier.
    expect(remuxer.seeks).toEqual([1200]);
  });

  it("laisse un saut remplacer l'ouverture au lieu de s'y ajouter", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() }, 1200);
    await flush();

    // Sauter avant que la tête soit posée : sans quoi elle serait ensuite ramenée au point
    // d'ouverture, et le film repartirait tout seul là où on venait de le quitter.
    await mse.seek(300);
    await flush();
    FakeSource.instances[0].buffers[0].setBuffered(1199, 1230);
    FakeSource.instances[0].buffers[1].setBuffered(1199, 1230);
    video.dispatchEvent(new Event("timeupdate"));
    await flush();

    expect(video.currentTime).not.toBeCloseTo(1200, 1);
  });

  it("steps the playhead onto media that begins just after it", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn() });
    await flush();
    const buffer = FakeSource.instances[0].buffers[0];

    // What a seek onto an index point produces: the media begins one presentation delay later
    // than the playhead, and the element would otherwise wait there indefinitely. Both tracks are
    // set, because an element plays only where all of them have media.
    (video as unknown as { currentTime: number }).currentTime = 600;
    buffer.setBuffered(600.2, 620);
    FakeSource.instances[0].buffers[1].setBuffered(600.2, 620);
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    // Landed a frame inside the media rather than on its first instant — see LANDING_INSET.
    expect(video.currentTime).toBeCloseTo(600.24, 3);
  });

  it("leaves a real hole in the stream alone rather than skipping over it", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn() });
    await flush();
    const buffer = FakeSource.instances[0].buffers[0];

    (video as unknown as { currentTime: number }).currentTime = 600;
    buffer.setBuffered(640, 660);
    FakeSource.instances[0].buffers[1].setBuffered(640, 660);
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    // Jumping forty seconds without being asked would hide a genuine fault behind a silent skip.
    expect(video.currentTime).toBe(600);
  });

  it("serves only the last of a burst of seeks", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();

    // A finger dragging across a scrub bar. Serving each in turn means every one is stale before
    // its media arrives, and the picture never catches up.
    void mse.seek(300);
    void mse.seek(900);
    await mse.seek(1500);
    await flush();

    expect(remuxer.seeks).toEqual([1499.8]);
  });

  it("sert le dernier saut d'une rafale arrivée pendant qu'une lecture réseau finissait", async () => {
    // Banc du 22/09/2026, serveur distant : cinq sauts en 0,6 s arrivaient au dernier en 6,5 s.
    // Le premier attendait la fin de la lecture en cours, puis lisait sa propre position — déjà
    // abandonnée — et le dernier attendait à son tour cette lecture-là.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2, true, 40);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    await new Promise((r) => setTimeout(r, 20));

    void mse.seek(300);
    // Le premier saut est parti, et attend la lecture en cours.
    await new Promise((r) => setTimeout(r, 5));
    void mse.seek(900);
    await mse.seek(1500);
    await flush();

    // Un seul saut servi, le dernier (moins le retard de présentation s'il est déjà connu).
    expect(remuxer.seeks).toHaveLength(1);
    expect(remuxer.seeks[0]).toBeGreaterThan(1499);
    mse.destroy();
  });

  it("n'attend plus la lecture en cours : un saut la coupe, sans la prendre pour une panne", async () => {
    // 22/09/2026, serveur lointain : un saut attendait jusqu'à deux secondes la fin d'une lecture
    // réseau de la position quittée. Il la coupe maintenant (`prepareSeek` → `ByteSource.abandon`),
    // et la boucle de lecture s'efface sans compter d'échec ni lancer de reprise.
    const { ReadAbandoned } = await import("@/lib/webcodecs/byteSource");
    traceReset();
    const video = fakeVideo();
    const onError = vi.fn();
    const remuxer = fakeRemuxer(500, 0.2);
    let hang: ((error: unknown) => void) | null = null;
    const nextSegment = remuxer.nextSegment.bind(remuxer);
    let slow = false;
    Object.assign(remuxer, {
      // Une lecture qui ne revient pas d'elle-même : dix secondes de réseau, disons.
      nextSegment: () => (slow ? new Promise((_, reject) => (hang = reject)) : nextSegment()),
      prepareSeek: () => hang?.(new ReadAbandoned()),
    });
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError });
    await flush();
    slow = true;
    // La tête avance : la boucle repart chercher, et reste suspendue à sa lecture.
    (video as unknown as { currentTime: number }).currentTime = 25;
    video.dispatchEvent(new Event("timeupdate"));
    (mse as unknown as { fill: () => Promise<void> }).fill();
    await flush();
    expect(hang).not.toBeNull();

    slow = false;
    const started = Date.now();
    await mse.seek(1200);
    await flush();
    expect(Date.now() - started).toBeLessThan(500);
    expect(remuxer.seeks).toEqual([1199.8]);
    expect(onError).not.toHaveBeenCalled();
    expect(traceText()).not.toContain("segment refusé");
    mse.destroy();
  });

  it("rend la lecture en avance entière dès que le saut a sa première image", async () => {
    // Voir `SEEK_PREFETCH_CHUNKS` : bridée pendant le saut, elle doit reprendre — sinon toute la
    // suite du film se lirait avec deux morceaux d'avance.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const settled = vi.fn();
    Object.assign(remuxer, { seekSettled: settled });
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    expect(settled).not.toHaveBeenCalled();
    await mse.seek(1200);
    await flush();
    expect(settled).toHaveBeenCalledTimes(1);
    mse.destroy();
  });

  describe("sauts qui partent ailleurs (banc iPhone du 22/09/2026)", () => {
    const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
    const onBrowser = (ua: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    afterEach(() => vi.restoreAllMocks());
    const withRate = (video: HTMLVideoElement) => Object.assign(video, { playbackRate: 1, seeking: false });

    it("redemande la cible d'un saut dont la tête part ailleurs, et l'écrit", async () => {
      onBrowser(CHROME);
      const video = withRate(fakeVideo());
      const remuxer = fakeRemuxer(200);
      const onStall = vi.fn();
      const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onStall });
      const internals = mse as unknown as { watchdog: () => void; watchdogTimer: ReturnType<typeof setInterval> | null };
      await until(() => video.buffered.length > 0 && video.buffered.end(0) > 20, "du média devant la tête");
      if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
      const seeksBefore = remuxer.seeks.length;

      // Un saut vers 5 s, dans ce qui est déjà là…
      (video as unknown as { currentTime: number }).currentTime = 5;
      video.dispatchEvent(new Event("seeking"));
      // …et la tête file à 20 s sans être jamais arrivée.
      (video as unknown as { currentTime: number }).currentTime = 20;
      internals.watchdog();
      await flush();

      expect(remuxer.seeks.length).toBe(seeksBefore + 1);
      expect(remuxer.seeks.at(-1)).toBeCloseTo(5 - 0.2, 1);
      expect(onStall).toHaveBeenCalledWith(expect.objectContaining({ runaway: true, seekTarget: 5 }));
      expect(traceText()).toContain("saut parti ailleurs");
      mse.destroy();
    });

    it("laisse passer une tête encore en train de sauter", async () => {
      // Banc iPhone du 22/09/2026, Titanic : cinq sauts en 0,4 s. Le navigateur applique
      // `currentTime` tout de suite et n'émet `seeking` qu'ensuite — dans cet intervalle, la tête
      // est déjà au cinquième saut alors que la cible connue est encore celle du quatrième. Le
      // détecteur y voyait une fuite et ramenait la tête 935 s en arrière, défaisant le dernier
      // saut du spectateur. Une tête en route ne s'est pas égarée : elle n'est pas encore arrivée.
      onBrowser(CHROME);
      const video = withRate(fakeVideo());
      const remuxer = fakeRemuxer(200);
      const onStall = vi.fn();
      const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onStall });
      const internals = mse as unknown as { watchdog: () => void; watchdogTimer: ReturnType<typeof setInterval> | null };
      await until(() => video.buffered.length > 0 && video.buffered.end(0) > 20, "du média devant la tête");
      if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
      const seeksBefore = remuxer.seeks.length;

      (video as unknown as { currentTime: number }).currentTime = 5;
      video.dispatchEvent(new Event("seeking"));
      // Le saut suivant : la tête y est déjà, son `seeking` n'est pas encore arrivé.
      (video as unknown as { currentTime: number }).currentTime = 20;
      Object.assign(video, { seeking: true });
      internals.watchdog();
      await flush();

      expect(remuxer.seeks.length).toBe(seeksBefore);
      expect(onStall).not.toHaveBeenCalled();
      mse.destroy();
    });

    it("rattrape quand même une tête restée en plein saut au-delà de six secondes", async () => {
      // La garde du dessus ne doit pas désarmer le filet : un saut qui ne se pose jamais, la tête
      // ailleurs que sa cible, est toujours ramené — seulement après l'attente d'une horloge figée
      // pendant un saut.
      onBrowser(CHROME);
      const video = withRate(fakeVideo());
      const remuxer = fakeRemuxer(200);
      const onStall = vi.fn();
      const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onStall });
      const internals = mse as unknown as { watchdog: () => void; watchdogTimer: ReturnType<typeof setInterval> | null };
      await until(() => video.buffered.length > 0 && video.buffered.end(0) > 20, "du média devant la tête");
      if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
      const seeksBefore = remuxer.seeks.length;

      const t0 = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
      (video as unknown as { currentTime: number }).currentTime = 5;
      video.dispatchEvent(new Event("seeking"));
      (video as unknown as { currentTime: number }).currentTime = 20;
      Object.assign(video, { seeking: true });

      clock.mockReturnValue(t0 + 5_000);
      internals.watchdog();
      await flush();
      expect(remuxer.seeks.length).toBe(seeksBefore);

      clock.mockReturnValue(t0 + 6_500);
      internals.watchdog();
      await flush();
      expect(remuxer.seeks.length).toBe(seeksBefore + 1);
      expect(onStall).toHaveBeenCalledWith(expect.objectContaining({ runaway: true, seekTarget: 5 }));
      mse.destroy();
    });

    it("fait reconstruire à la cible, pas là où la tête s'est enfuie, quand les reprises n'y suffisent plus", async () => {
      // Audit du 22/09/2026 : la reconstruction partait de `position`, c'est-à-dire de la tête
      // partie ailleurs.
      onBrowser(CHROME);
      const video = withRate(fakeVideo());
      const onError = vi.fn();
      const mse = await MseSource.attach(video, fakeRemuxer(200), PLAN, { onError });
      const internals = mse as unknown as { recover: (t: number) => boolean; watchdog: () => void; watchdogTimer: ReturnType<typeof setInterval> | null };
      await until(() => video.buffered.length > 0 && video.buffered.end(0) > 20, "du média devant la tête");
      if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
      // Plus aucune reprise possible : la main passe à l'hôte.
      internals.recover = () => false;

      (video as unknown as { currentTime: number }).currentTime = 5;
      video.dispatchEvent(new Event("seeking"));
      (video as unknown as { currentTime: number }).currentTime = 20;
      internals.watchdog();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(mse.lost).toBe(true);
      expect(mse.position).toBe(5);
      mse.destroy();
    });

    it("laisse jouer un saut arrivé : la tête qui avance ensuite n'est pas un départ", async () => {
      onBrowser(CHROME);
      const video = withRate(fakeVideo());
      const remuxer = fakeRemuxer(200);
      const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
      const internals = mse as unknown as { watchdog: () => void; watchdogTimer: ReturnType<typeof setInterval> | null };
      await until(() => video.buffered.length > 0 && video.buffered.end(0) > 20, "du média devant la tête");
      if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
      const seeksBefore = remuxer.seeks.length;

      (video as unknown as { currentTime: number }).currentTime = 5;
      video.dispatchEvent(new Event("seeking"));
      video.dispatchEvent(new Event("seeked"));
      (video as unknown as { currentTime: number }).currentTime = 9;
      internals.watchdog();
      await flush();
      expect(remuxer.seeks.length).toBe(seeksBefore);
      mse.destroy();
    });
  });

  describe("chasse aux bugs du 22/09/2026 au soir", () => {
    it("libère un saut ramené dans la durée du film — +30 s dans les dernières secondes ne fige plus rien", async () => {
      // La cible était ramenée à la fin du média, puis comparée ainsi corrigée à la demande
      // d'origine pour la libérer : elles ne correspondaient plus, la demande restait pendante,
      // et le remplissage comme le chien de garde s'arrêtaient devant elle.
      const video = fakeVideo();
      const remuxer = fakeRemuxer(500);
      const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
      await flush();
      await mse.seek(3630);
      await flush();
      expect(mse.seekPending).toBe(false);
      expect(remuxer.seeks.at(-1)).toBeGreaterThan(3590);
      mse.destroy();
    });

    it("libère un saut refusé sur un fichier sans index, et rend la tête là où elle jouait", async () => {
      const video = fakeVideo();
      const onWarning = vi.fn();
      const mse = await MseSource.attach(video, fakeRemuxer(500, 0.2, false), PLAN, { onError: vi.fn(), onWarning });
      const internals = mse as unknown as { watchdog: () => void; watchdogTimer: ReturnType<typeof setInterval> | null };
      await until(() => video.buffered.length > 0 && video.buffered.end(0) > 10, "du média");
      if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
      (video as unknown as { currentTime: number }).currentTime = 5;
      internals.watchdog();

      (video as unknown as { currentTime: number }).currentTime = 1800;
      video.dispatchEvent(new Event("seeking"));
      await flush();
      expect(onWarning).toHaveBeenCalledWith({ code: "noIndexSeek" });
      expect(mse.seekPending).toBe(false);
      expect(video.currentTime).toBe(5);
      mse.destroy();
    });

    it("ne prend pas pour son propre déplacement un saut du spectateur, longtemps après, au même endroit", async () => {
      // « Revoir » à la fin d'un film restait figé à 0:00 : la source avait posé la tête à 0,24 s
      // à l'ouverture, et tout saut à moins de 0,25 s de là passait pour le sien, des heures après.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const video = fakeVideo();
        const remuxer = fakeRemuxer(500);
        const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
        await flush();
        const timer = (mse as unknown as { watchdogTimer: ReturnType<typeof setInterval> | null }).watchdogTimer;
        if (timer) clearInterval(timer);
        (mse as unknown as { seekState: { moved: (t: number) => void } }).seekState.moved(1000.2);
        vi.setSystemTime(Date.now() + 60_000);
        traceReset();
        (video as unknown as { currentTime: number }).currentTime = 1000;
        video.dispatchEvent(new Event("seeking"));
        // Servi tout de suite, par le saut lui-même — pas rattrapé plus tard par une reprise.
        expect(traceText()).toContain("saut demandé vers 1000.0 s (le viseur)");
        mse.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("renvoie un lecteur égaré vers la cible du saut en cours, pas vers la tête partie ailleurs", async () => {
      // Deux relectures pour un seul saut : d'abord vers la tête enfuie, puis vers la cible.
      const video = fakeVideo();
      const remuxer = fakeRemuxer(500, 0.2, true, 20);
      const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
      await flush();
      // Le contrôle d'égarement de la boucle de lecture seul : le chien de garde, qui le
      // rattraperait vers la bonne cible, est arrêté.
      const timer = (mse as unknown as { watchdogTimer: ReturnType<typeof setInterval> | null }).watchdogTimer;
      if (timer) clearInterval(timer);
      (video as unknown as { currentTime: number }).currentTime = 1000;
      video.dispatchEvent(new Event("seeking"));
      // Le média du saut commence d'arriver, là où il a été demandé.
      await until(() => video.buffered.length > 0 && video.buffered.start(0) < 1100 && video.buffered.start(0) > 900, "le média du saut");
      // La tête s'en va sans que l'élément le dise.
      (video as unknown as { currentTime: number }).currentTime = 1600;
      await new Promise((r) => setTimeout(r, 300));
      expect(remuxer.seeks.some((t) => Math.abs(t - 1599.8) < 0.01)).toBe(false);
      mse.destroy();
    });
  });

  it("ne signale pas une seconde erreur après avoir passé la main à l'hôte", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    const mse = await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError });
    await flush();
    const internals = mse as unknown as { handOver: (at: number) => void; recover: () => boolean; seek: (t: number) => Promise<void>; performSeek: () => Promise<void> };
    internals.handOver(12);
    expect(onError).toHaveBeenCalledTimes(1);
    internals.recover = () => false;
    internals.performSeek = async () => {
      throw new Error("refusé");
    };
    await internals.seek(40);
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    mse.destroy();
  });

  it("keeps a playable amount of media even while the system says it wants none", async () => {
    const video = fakeVideo();
    class NeverStreaming extends FakeSource {
      streaming = false;
    }
    vi.stubGlobal("ManagedMediaSource", NeverStreaming);
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn() });
    await flush();

    const buffer = FakeSource.instances[0].buffers[0];
    // Obeying the system unconditionally means that if it says "stop" while the buffer in front
    // of the playhead is empty, nothing is ever fetched again and the player loads forever.
    expect(buffer.buffered.length).toBeGreaterThan(0);
    expect(buffer.buffered.end(0)).toBeGreaterThanOrEqual(8);
    // But it is a floor, not a licence to ignore the request: it stops well short of the target.
    expect(buffer.buffered.end(0)).toBeLessThan(30);
  });

  it("recovers a playhead that moved without the element ever saying so", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    expect(remuxer.seeks).toEqual([]);

    // Everything else here reacts to an event, and any of them can fail to arrive. The symptom
    // is always the same: the playhead is somewhere no media is, and the reader is elsewhere.
    (video as unknown as { currentTime: number }).currentTime = 1500;
    await new Promise((r) => setTimeout(r, 1200));
    expect(remuxer.seeks).toEqual([1499.8]);
  }, 10_000);

  it("stops reading a place the viewer has left, and goes to where they are", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    const buffer = FakeSource.instances[0].buffers[0];

    // The playhead is far from the media being fetched and nothing said so. Reading its way
    // there one segment at a time is exactly what a seek looks like when it appears to
    // recalculate the entire film — and the watchdog cannot catch it, because media *is*
    // arriving, just nowhere useful.
    (video as unknown as { currentTime: number }).currentTime = 1500;
    buffer.setBuffered(0, 40);
    video.dispatchEvent(new Event("timeupdate"));
    await flush();

    expect(remuxer.seeks).toEqual([1499.8]);
  });

  it("never runs two operations on one buffer at once, however they arrive", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    const mse = await MseSource.attach(video, fakeRemuxer(500, 0.2, true, 3), PLAN, { onError, onWarning: vi.fn() });
    await flush();
    for (const buffer of FakeSource.instances[0].buffers) buffer.busyMs = 6;

    // MediaSource permits exactly one operation per buffer, and the things that touch one are
    // driven by unrelated events: a seek, the read loop, eviction. Firing them into the same
    // instant is what produced a freeze that a second seek then undid.
    await Promise.all([
      mse.seek(600),
      mse.seek(900),
      (async () => {
        video.dispatchEvent(new Event("timeupdate"));
        video.dispatchEvent(new Event("waiting"));
      })(),
    ]);
    await flush();
    await flush();

    expect(onError).not.toHaveBeenCalled();
  });

  it("clamps a seek past the end to the media, instead of chasing a place that is not there", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();

    // PLAN runs an hour. Asking for two would send the reader somewhere there is nothing to
    // read, and the recovery machinery would then keep trying to reach a time that does not exist.
    await mse.seek(7200);
    expect(remuxer.seeks[0]).toBeLessThanOrEqual(PLAN.durationSeconds);
    expect(video.currentTime).toBeLessThanOrEqual(PLAN.durationSeconds + 0.2);
  });

  it("empties the queued sound the instant pause is pressed, not a second later", async () => {
    const video = fakeVideo();
    const mse = await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    (video as unknown as { currentTime: number }).currentTime = 12;
    (video as unknown as { paused: boolean }).paused = true;

    video.dispatchEvent(new Event("pause"));

    // No waiting: a pause followed straight away by a play is precisely the case a delay leaves
    // untouched, and it is the one where the delay is most obvious.
    expect(mse.debug["Dernière pause"]).toContain("recalé");
    expect(video.currentTime).toBe(12);
  });

  it("lets a resume land where the sound actually stopped, half a second on", async () => {
    const video = fakeVideo();
    // Dix segments, soit vingt secondes de média, et non cinq cents.
    //
    // La boucle de lecture n'est pas commandée par des minuteurs : figer le temps ne l'arrête
    // pas. Avec cinq cents segments elle continuait donc de remplir le tampon pendant que le
    // test observait la reprise, et les surveillances de la source, voyant une horloge immobile
    // devant un tampon qui s'allonge, poussaient la tête de lecture loin en avant — 600 s, une
    // fois sur six, selon la charge de la machine. Un média borné retire la course : le tampon
    // couvre les vingt secondes attendues et cesse de croître.
    const remuxer = fakeRemuxer(10, 0.2);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);
    // Waited for rather than assumed: how far the reader has got by now depends on the machine,
    // and this case is about a playhead standing on media. On a loaded machine it was sometimes
    // standing on nothing instead, which is a different test and an occasional red build.
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 13, "le tampon couvre 13 s");

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));

    // Measured on a device: the picture freezes at the button, the sound the hardware already
    // held plays on, and the clock reports that half-second at the moment of resuming. Nothing
    // was skipped — it was heard while the picture stood still — so pulling it back would replay
    // it and show the wrong frame for a moment.
    // Le temps est figé le temps de la reprise, et lui seul.
    //
    // L'horloge de cet élément n'avance jamais toute seule — rien dans une vidéo simulée ne le
    // fait — donc dès qu'il joue avec du média devant lui, il est indiscernable d'un élément
    // réellement bloqué : les surveillances de la source ont le droit de le pousser, et sur une
    // machine chargée elles en ont le temps. Le test devenait alors rouge pour la raison même
    // qu'il ne teste pas. Avec des minuteurs simulés, aucune d'elles ne se déclenche, et ce qui
    // reste mesuré est ce qui était visé : la reprise ne recule pas.
    vi.useFakeTimers();
    try {
      setTime(12.49);
      (video as unknown as { paused: boolean }).paused = false;
      video.dispatchEvent(new Event("play"));
      await vi.advanceTimersByTimeAsync(0);

      expect(video.currentTime).toBeGreaterThanOrEqual(12.49);
      expect(video.currentTime).toBeLessThan(12.8);
    } finally {
      vi.useRealTimers();
    }
    // The behaviour under test is that the resume is not pulled *back* to where the pause was.
    // Asserting that nothing in the whole source asked for any seek at all made this fail on a
    // loaded machine for a reason that had nothing to do with it — the watchdog doing its job.
    expect(remuxer.seeks.filter((at) => at < 12.4)).toEqual([]);
  });

  it("fetches the position back when the system reclaimed it during the pause", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);
    const buffers = FakeSource.instances[0].buffers;

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));

    // ManagedMediaSource is allowed to reclaim buffered media while nothing is playing, and on a
    // phone it does. The element then comes back to find nothing where it was and carries on
    // from the nearest media it still holds — which is the jump forward, not a drift.
    for (const b of buffers) b.setBuffered(40, 70);
    setTime(40); // seconds ahead: a real discontinuity, not the sound playing on
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    await flush();

    // Restoring is impossible without reading again, and giving up would leave the jump in place.
    expect(remuxer.seeks).toEqual([11.8]);
  });

  it("still puts it back when the jump happens a moment after playback resumes", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));
    (video as unknown as { paused: boolean }).paused = false;
    // The play event fires before the element has actually resumed, so nothing has moved yet.
    video.dispatchEvent(new Event("play"));
    await flush();
    expect(video.currentTime).toBe(12);

    // Far beyond the half-second the sound plays on for: a real discontinuity, arriving after the
    // play event rather than at it, which is why the guard has to keep looking for a moment.
    setTime(19);
    video.dispatchEvent(new Event("playing"));
    await flush();
    // Same range and same reason as above: what is under test is that the position was put back
    // at all rather than left at nineteen, and the frozen-clock check may have pushed it on a
    // little while the test was still running.
    expect(video.currentTime).toBeGreaterThanOrEqual(12);
    expect(video.currentTime).toBeLessThan(12.5);
  });

  it("lets playback simply carry on after resuming, without pulling it back", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));

    // Playback passes the pause position within a tenth of a second of resuming. Reading that as
    // a jump is a yank backwards, and — where the media there has been reclaimed — a full re-read
    // for nothing: a resume that lands a second out with a stutter, which is what was reported.
    await new Promise((r) => setTimeout(r, 120));
    setTime(12.1);
    video.dispatchEvent(new Event("timeupdate"));
    await flush();

    expect(video.currentTime).toBe(12.1);
    expect(remuxer.seeks).toEqual([]);
  });

  it("anchors where the sound actually stopped, not where the button was pressed", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));
    // The clock keeps going for a fraction of a second: the sound already handed to the hardware
    // plays out, and it was heard. Anchoring before it makes resuming replay it.
    for (const t of [12.2, 12.4, 12.5]) {
      setTime(t);
      await new Promise((r) => setTimeout(r, 90));
    }

    // Resuming from where it truly stopped: nothing to undo, and nothing replayed.
    setTime(12.5);
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    await flush();
    expect(video.currentTime).toBe(12.5);
    expect(remuxer.seeks).toEqual([]);
  }, 10_000);

  it("does not undo its own step onto the media when resuming", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);
    const buffers = FakeSource.instances[0].buffers;

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));

    // Resuming just short of the media: the step onto it is deliberate and small. Reading that
    // step as a jump and undoing it shows a frame from further on and then the right one, which
    // is the flicker reported — and which way round it looks depends on when the eye catches it.
    for (const b of buffers) b.setBuffered(12.2, 40);
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    await flush();
    expect(video.currentTime).toBeCloseTo(12.24, 3);

    setTime(12.3);
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(video.currentTime).toBe(12.3);
    expect(remuxer.seeks).toEqual([]);
  });

  it("leaves a playhead the viewer moved while paused exactly where they put it", async () => {
    const video = fakeVideo();
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));
    // Backwards, and far: a deliberate move, not a fraction of a second of drift.
    setTime(5);
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    await flush();

    expect(video.currentTime).toBe(5);
  });

  it("garde un saut en avant fait pendant la pause, dans ce qui est déjà chargé", async () => {
    // Audit du 22/09/2026 : le raccourci « saut dans le tampon » sortait sans prévenir la garde de
    // pause. Pause, saut en avant plus d'une seconde après, Lecture : la garde voyait la tête « trop
    // loin » de sa position de pause et l'y ramenait. Seul le saut en arrière était couvert.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 26, "du média devant la tête");
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));
    // Plus que la fenêtre où la garde adopte d'elle-même la position.
    await new Promise((r) => setTimeout(r, 1200));
    setTime(25);
    video.dispatchEvent(new Event("seeking"));
    video.dispatchEvent(new Event("seeked"));
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    await flush();
    video.dispatchEvent(new Event("timeupdate"));
    await flush();

    expect(video.currentTime).toBe(25);
    expect(remuxer.seeks).toEqual([]);
  }, 10_000);

  it("ne remplit pas la trace d'un saut de lignes « après envoi »", async () => {
    // Écrite à chaque segment, elle occupait les quarante étapes des lignes `seek` et `stall`.
    const video = fakeVideo();
    const mse = await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn() });
    await flush();
    traceReset();
    await mse.seek(1200);
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 1215, "vingt secondes de média");
    // Les lignes de ce lecteur-ci : d'autres sources de la suite, encore vivantes, écrivent dans
    // la même trace — leur tête n'est pas à 1 200 s.
    const lines = traceText()
      .split("\n")
      .filter((l) => l.includes("après envoi") && Number(/tête à ([\d.]+)/.exec(l)?.[1] ?? 0) >= 1199);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(6);
    mse.destroy();
  });

  it("does not move the picture under a viewer who has paused", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();

    (video as unknown as { currentTime: number }).currentTime = 1500;
    (video as unknown as { paused: boolean }).paused = true;
    await new Promise((r) => setTimeout(r, 1200));
    // Stranded, but paused: the frame on screen is already drawn and needs nothing. Seeking here
    // would move the picture on its own and land the resume somewhere else.
    expect(remuxer.seeks).toEqual([]);
  }, 10_000);

  it("clears the starting state on the very first play, before anything has been paused", async () => {
    const video = fakeVideo();
    const onStarting = vi.fn();
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn(), onWarning: vi.fn(), onStarting });
    await flush();

    // The automatic play at the start, with no pause ever having happened. Tying the clearing to
    // the pause trace left this raised for ever: a spinner that never went away, and controls
    // that hide the button behind it — so playback could not even be paused to recover.
    video.dispatchEvent(new Event("play"));
    expect(onStarting).toHaveBeenLastCalledWith(expect.any(Number));

    (video as unknown as { currentTime: number }).currentTime = 0.5;
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(onStarting).toHaveBeenLastCalledWith(null);
  });

  it("waits for a picture to be presented, not for the event that precedes one", async () => {
    const video = fakeVideo();
    const onStarting = vi.fn();
    // Frame-accurate notification, as Safari and Chromium both provide.
    // Held in an object rather than a bare variable: assigning only from inside the callbacks
    // lets TypeScript narrow the variable to never, and the calls below stop compiling.
    const frame: { next: ((now: number, meta: { mediaTime: number }) => void) | null } = { next: null };
    Object.assign(video, {
      requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => {
        frame.next = cb;
        return 1;
      },
      cancelVideoFrameCallback: () => {
        frame.next = null;
      },
    });
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn(), onWarning: vi.fn(), onStarting });
    await flush();

    (video as unknown as { currentTime: number }).currentTime = 12;
    video.dispatchEvent(new Event("play"));
    expect(onStarting).toHaveBeenLastCalledWith(expect.any(Number));

    // This one fires as soon as play is called, before the pipeline has begun. Treating it as
    // the answer means nothing is ever shown at all.
    video.dispatchEvent(new Event("playing"));
    expect(onStarting).toHaveBeenLastCalledWith(expect.any(Number));

    // A frame still at the old position: the picture has not moved.
    frame.next?.(0, { mediaTime: 12 });
    expect(onStarting).toHaveBeenLastCalledWith(expect.any(Number));

    // And one that has.
    frame.next?.(0, { mediaTime: 12.04 });
    expect(onStarting).toHaveBeenLastCalledWith(null);
  });

  it("says when it has been asked to start and has not yet, and when it has", async () => {
    const video = fakeVideo();
    const onStarting = vi.fn();
    await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn(), onWarning: vi.fn(), onStarting });
    await flush();
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

    setTime(12);
    (video as unknown as { paused: boolean }).paused = true;
    video.dispatchEvent(new Event("pause"));
    onStarting.mockClear();

    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    // Reported as a fact, not as a platform: a caller can show that something is happening
    // without asking which browser it is in, and a desktop clears this within a frame.
    expect(onStarting).toHaveBeenLastCalledWith(expect.any(Number));

    setTime(12.1);
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(onStarting).toHaveBeenLastCalledWith(null);
  });

  it("lands the playhead on the media a seek actually produced", async () => {
    // An index is not exact. Asking a real file for 1568 s produced media beginning at 1570.6,
    // and no amount of waiting or asking again could ever make it cover 1568: the recovery asked
    // three times, was served three times, and the playhead stood on nothing until the reader
    // concluded the browser was keeping nothing and declared playback over. A media element
    // seeking into a gap lands on the nearest media it has, and so does this.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const onError = vi.fn();
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError, onWarning: vi.fn() });
    await flush();
    for (const buffer of FakeSource.instances[0].buffers) buffer.landsLate = 2.6;

    await mse.seek(100);
    await until(() => video.currentTime > 100, "la tête rejoint le média");

    expect(video.currentTime).toBeGreaterThanOrEqual(102.6);
    expect(video.currentTime).toBeLessThan(104);
    expect(onError).not.toHaveBeenCalled();

    // And the licence expires with the landing. Left standing, it let a pause much later step
    // fifteen seconds forward on its own — which is exactly what it did.
    const settled = video.currentTime;
    (video as unknown as { paused: boolean }).paused = true;
    for (const buffer of FakeSource.instances[0].buffers) buffer.landsLate = 8;
    (video as unknown as { currentTime: number }).currentTime = settled + 1;
    video.dispatchEvent(new Event("timeupdate"));
    await new Promise((r) => setTimeout(r, 120));
    expect(video.currentTime).toBeCloseTo(settled + 1, 1);
  });

  it("says a source has been lost, rather than only failing on it later", async () => {
    // Everything a report ever showed of a closed source was the consequence: some later
    // operation tripping over the wreckage. The caller needs to be able to ask directly, because
    // a source the platform closed is not a fault to report — it is a pipeline to build again.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    expect(mse.lost).toBe(false);

    FakeSource.instances[0].readyState = "closed";
    expect(mse.lost).toBe(true);
    // And where to come back to.
    (video as unknown as { currentTime: number }).currentTime = 42;
    expect(mse.position).toBe(42);
  });

  it("gives a refused seek the same second chance as a refused append", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const onError = vi.fn();
    const onWarning = vi.fn();
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError, onWarning });
    await flush();

    // Reading the ranges of a buffer whose source has closed throws, and a seek reads them before
    // it can clear anything. Declaring playback over on the first of these is what turned "one
    // seek too many" into a dead player.
    const [videoBuffer] = FakeSource.instances[0].buffers;
    const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(videoBuffer), "buffered");
    let refused = false;
    Object.defineProperty(videoBuffer, "buffered", {
      configurable: true,
      get() {
        if (!refused) {
          refused = true;
          throw Object.assign(new Error("The object is in an invalid state."), { name: "InvalidStateError" });
        }
        return own?.get?.call(this) ?? { length: 0 };
      },
    });

    await mse.seek(40);
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it("is ready without waiting for the buffer to fill", async () => {
    const video = fakeVideo();
    // A remuxer that never returns: attaching must still complete, or a slow or unhelpful
    // browser holds the whole session hostage behind a spinner with no reason to stop.
    const stuck = { plan: () => PLAN, seekable: true, seeks: [], diagnostics: () => ({ presentationDelaySeconds: 0.2, clampedSamples: 0 }), seekTo: () => {}, nextSegment: () => new Promise(() => {}) };
    await expect(
      MseSource.attach(video, stuck as never, PLAN, { onError: vi.fn(), onWarning: vi.fn() })
    ).resolves.toBeDefined();
  });

  it("stops reading a film the browser is keeping nothing from", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    await MseSource.attach(video, fakeRemuxer(5000), PLAN, { onError, onWarning: vi.fn() });
    await flush();

    const buffers = FakeSource.instances[0].buffers;
    // Accepted and discarded: every append succeeds, and the depth never moves. Reading the rest
    // of the film to discover that is the worst possible answer.
    for (const b of buffers) b.secondsPerAppend = 0;
    (video as unknown as { currentTime: number }).currentTime = 5;
    video.dispatchEvent(new Event("timeupdate"));
    await new Promise((r) => setTimeout(r, 100));

    const appendsWhileFruitless = buffers[0].appended.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(buffers[0].appended.length).toBe(appendsWhileFruitless);
  }, 10_000);

  it("detaches cleanly, leaving nothing listening", async () => {
    const video = fakeVideo();
    const mse = await MseSource.attach(video, fakeRemuxer(50), PLAN, { onError: vi.fn() });
    await flush();
    mse.destroy();
    const source = FakeSource.instances[0];
    const before = source.buffers[0].appended.length;
    source.dispatchEvent(new Event("startstreaming"));
    await flush();
    expect(source.buffers[0].appended.length).toBe(before);
    expect((video as unknown as { srcObject: unknown }).srcObject).toBeNull();
  });
});

/**
 * Le démontage sur la branche à URL, c'est-à-dire chez tout le monde.
 *
 * `fakeVideo` accepte n'importe quoi dans `srcObject` et prend donc la branche préférée, celle
 * qui n'a pas d'URL à révoquer. Aucun navigateur de la bibliothèque ne fait cela : Chrome — le
 * seul que le journal du lecteur montre sur le chemin `remux` — refuse `srcObject = MediaSource`
 * et se rabat sur `createObjectURL`. Ce banc modélise cet élément-là, y compris le détail qui
 * faisait le défaut : écrire `srcObject`, même avec `null`, relance l'algorithme de chargement,
 * lequel retombe sur l'attribut `src` quand il ne trouve pas de `srcObject`.
 */
function videoRefusingSrcObject(fetched: string[]): HTMLVideoElement {
  const video = fakeVideo() as unknown as { src: string; removeAttribute: (name: string) => void };
  Object.defineProperty(video, "srcObject", {
    get: () => null,
    set: (value: unknown) => {
      if (value !== null) throw new TypeError("srcObject n'accepte qu'un MediaStream");
      if (video.src) fetched.push(video.src);
    },
    configurable: true,
  });
  video.removeAttribute = (name: string) => {
    if (name === "src") video.src = "";
  };
  return video as unknown as HTMLVideoElement;
}

/**
 * L'échelle des reprises, et ce qu'elle écrit au journal.
 *
 * 22/09/2026, sur un iPhone : un saut de −10 s tombé juste avant une image clé (espacées de 10,43 s
 * dans ce film), `seeked`, puis une horloge tenue entre 166 et 167 s pendant dix-neuf secondes sous
 * l'indicateur de chargement — jusqu'à ce que le spectateur saute ailleurs. Deux verrous : la
 * fenêtre des reprises rafraîchie par les appels *abandonnés* (le chien de garde appelle toutes les
 * 250 ms, elle n'expirait donc jamais), et l'horloge figée laissée seule après trois poussées.
 */
describe("l'échelle des reprises", () => {
  /** Les parties privées que ces tests pilotent à la main, pour ne dépendre d'aucune horloge réelle. */
  type Internals = {
    watchdog: () => void;
    watchdogTimer: ReturnType<typeof setInterval> | null;
    fill: () => Promise<void>;
    fillTask: Promise<void> | null;
    watchForFrozenClock: (at: number) => void;
    watchForStall: () => void;
    frozenSince: number | null;
    frozenNudges: number;
  };
  const internalsOf = (mse: MseSource) => mse as unknown as Internals;
  /** Les images clés du fichier, sur son horloge. */
  const withKeyframes = <T extends object>(remuxer: T, times: number[]) =>
    Object.assign(remuxer, { keyframeAfter: (s: number) => times.find((t) => t > s) ?? null });
  const setTime = (video: HTMLVideoElement, t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

  afterEach(() => vi.useRealTimers());

  it("ne s'arrête plus après trois reprises : image clé suivante, puis reconstruction demandée", async () => {
    const video = fakeVideo();
    const remuxer = withKeyframes(fakeRemuxer(500, 0.2), [156.4, 166.9, 177.3]);
    const onError = vi.fn();
    const onStall = vi.fn();
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError, onWarning: vi.fn(), onStall });
    const internals = internalsOf(mse);
    await until(() => internals.fillTask === null && video.buffered.length > 0, "le premier remplissage est fini");

    // Le chien de garde est mené à la main, 250 ms par 250 ms, sur une horloge simulée : c'est
    // exactement la cadence qui gardait la fenêtre des reprises ouverte pour toujours.
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    // Et rien n'arrive jamais sous la tête : c'est le cas où redemander la position ne sert à rien.
    internals.fill = () => Promise.resolve();
    vi.useFakeTimers({ toFake: ["Date"] });
    const tick = async () => {
      vi.setSystemTime(Date.now() + 250);
      internals.watchdog();
      await flush();
    };

    setTime(video, 166);
    for (let i = 0; i < 60 && onError.mock.calls.length === 0; i++) await tick();

    // Trois demandes de la même position, comme avant…
    expect(remuxer.seeks.filter((at) => Math.abs(at - 165.8) < 0.01)).toHaveLength(3);
    // …puis l'image clé suivante (166,9 s du fichier, donc 167,1 s du lecteur, un peu dedans)…
    expect(remuxer.seeks.some((at) => Math.abs(at - 167.0) < 0.01)).toBe(true);
    // …puis, elle aussi sans effet, la main passée à l'hôte comme pour une source perdue.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe("playback");
    expect(mse.lost).toBe(true);

    // Borné : plus rien ne part d'ici, l'hôte reconstruit.
    const seeksSoFar = remuxer.seeks.length;
    for (let i = 0; i < 40; i++) await tick();
    expect(remuxer.seeks).toHaveLength(seeksSoFar);
    expect(onError).toHaveBeenCalledTimes(1);

    // Et le blocage s'est écrit au journal, une fois — le chien de garde le surveille même après
    // avoir passé la main, puisque c'est précisément là que tout le reste s'est tu.
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toMatchObject({ recoveries: 6, filling: false });
  });

  it("compte ses propres poussées : une horloge qui n'a bougé que d'elles reste figée", async () => {
    // 22/09/2026, 1917 sur iPhone : douze poussées en quarante secondes, aucune reprise. Chaque
    // poussée avance l'horloge de 0,08 s — plus que le seuil de mouvement — et remettait donc le
    // compteur à zéro : le troisième barreau n'était jamais atteint.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(200);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    const internals = internalsOf(mse);
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 5, "du média devant la tête");
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);

    setTime(video, 0.25);
    video.dispatchEvent(new Event("play"));
    internals.watchForFrozenClock(video.currentTime);
    for (let i = 0; i < 4; i++) {
      internals.frozenSince = Date.now() - 5000;
      // L'horloge est là où la poussée l'a mise, et n'en bouge pas.
      internals.watchForFrozenClock(video.currentTime);
    }
    await flush();
    // Trois poussées, puis une vraie reprise : la position redemandée à la source, tampons vidés
    // et relus — là où l'horloge était, un pas plus loin.
    expect(remuxer.seeks).toHaveLength(1);
    expect(remuxer.seeks[0]).toBeCloseTo(0.25 + 4 * 0.08 - 0.2, 2);
    expect(traceText()).toContain("malgré 3 poussées");
  });

  it("laisse un saut en cours finir de décoder avant de le pousser", async () => {
    // Même soirée : Safari restait `seeking` avec trente secondes en tampon. Un saut au milieu
    // d'un groupe d'images oblige à décoder depuis l'image clé précédente — neuf secondes de 4K
    // pour 1917 —, et la poussée arrivait au bout d'une seconde et demie : elle relançait le
    // saut, qui repartait de l'image clé, et ainsi de suite. « Une seconde de lecture pour deux
    // de chargement », jusqu'à ce qu'un saut finisse par passer entre deux poussées.
    // La tête à neuf secondes du début du média, comme la cible de 1917 à neuf secondes de son
    // image clé : c'est ce que le décodeur doit traverser.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(200);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    const internals = internalsOf(mse);
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 12, "du média devant la tête");
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    const head = video.buffered.start(0) + 9;

    setTime(video, head);
    video.dispatchEvent(new Event("play"));
    Object.assign(video, { seeking: true });
    internals.watchForFrozenClock(head);
    internals.frozenSince = Date.now() - 2000;
    internals.watchForFrozenClock(head);
    expect(video.currentTime).toBe(head);

    // Un saut qui ne se résout vraiment jamais est poussé quand même, plus tard.
    internals.frozenSince = Date.now() - 8000;
    internals.watchForFrozenClock(head);
    expect(video.currentTime).toBeGreaterThan(head);
  });

  it("pousse plus tôt un saut qui n'a que quelques secondes à décoder", async () => {
    // Journal du 24/09/2026 : un +10 s dans une zone relue depuis une image clé à 2,8 s de la
    // cible, Safari figé en `seeking` six secondes, débloqué aussitôt par la poussée. Deux fois
    // dans la même séance sur un Mac, une fois sur un iPhone.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(200);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    const internals = internalsOf(mse);
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 12, "du média devant la tête");
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    const head = video.buffered.start(0) + 2.8;

    setTime(video, head);
    video.dispatchEvent(new Event("play"));
    Object.assign(video, { seeking: true });
    internals.watchForFrozenClock(head);
    // Encore dans le délai : 1,5 s plus 0,5 s par seconde à décoder, soit 2,9 s.
    internals.frozenSince = Date.now() - 2500;
    internals.watchForFrozenClock(head);
    expect(video.currentTime).toBe(head);
    internals.frozenSince = Date.now() - 3200;
    internals.watchForFrozenClock(head);
    expect(video.currentTime).toBeGreaterThan(head);
  });

  it("écrit un blocage une fois, avec de quoi le comprendre, et pas davantage", async () => {
    const video = fakeVideo();
    Object.assign(video, { readyState: 2, networkState: 2, seeking: false });
    const onStall = vi.fn();
    const mse = await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn(), onStall });
    const internals = internalsOf(mse);
    await until(() => internals.fillTask === null && video.buffered.length > 0, "le premier remplissage est fini");
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    vi.useFakeTimers({ toFake: ["Date"] });
    const after = (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
      internals.watchForStall();
    };

    setTime(video, 5);
    internals.watchForStall();
    // Trois secondes : rien encore — les reprises ont le temps d'agir avant que ce soit un fait.
    after(3000);
    expect(onStall).not.toHaveBeenCalled();
    after(2500);
    expect(onStall).toHaveBeenCalledTimes(1);
    const facts = onStall.mock.calls[0][0] as Record<string, unknown>;
    expect(facts).toMatchObject({
      position: 5,
      readyState: 2,
      networkState: 2,
      seeking: false,
      source: "open",
      filling: false,
      recoveryStreak: 0,
      frozenNudges: 0,
      recoveries: 0,
      streaming: true,
    });
    expect(facts.stalledMs).toBeGreaterThanOrEqual(5000);
    expect(facts.videoBuffered).toMatch(/^0\.00–\d+\.\d\d$/);
    expect(facts.audioBuffered).toMatch(/–/);
    expect(facts.lead).toBeGreaterThan(0);
    expect(typeof facts.sinceAppendMs).toBe("number");
    // Rien d'imbriqué au-delà d'un niveau : `clean()` jetterait le reste.
    for (const value of Object.values(facts)) expect(typeof value === "object" && value !== null).toBe(false);
    expect(facts.steps).toContain("lecture bloquée");

    // Le même blocage qui dure : pas une ligne de plus.
    after(10_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    // Il repart, se refige aussitôt : un nouvel épisode, mais dans la minute — toujours rien.
    setTime(video, 7);
    after(250);
    after(6000);
    expect(onStall).toHaveBeenCalledTimes(1);
    // Passé la minute, un nouveau blocage s'écrit.
    after(60_000);
    setTime(video, 9);
    after(250);
    after(6000);
    expect(onStall).toHaveBeenCalledTimes(2);

    // Et une pause n'est pas un blocage.
    (video as unknown as { paused: boolean }).paused = true;
    after(120_000);
    after(6000);
    expect(onStall).toHaveBeenCalledTimes(2);
  });
  it("ne prend pas l'attente réseau d'un saut pour un blocage, mais garde le saut qui ne se résout pas", async () => {
    // Banc du 22/09/2026, serveur lointain : quatre lignes `stall`, toutes des sauts qui
    // attendaient leur média — la ligne `seek` en porte déjà la durée.
    const video = fakeVideo();
    const onStall = vi.fn();
    const mse = await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn(), onStall });
    const internals = internalsOf(mse);
    await until(() => internals.fillTask === null && video.buffered.length > 0, "le premier remplissage est fini");
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    vi.useFakeTimers({ toFake: ["Date"] });
    const after = (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
      internals.watchForStall();
    };

    // Tête loin de tout média, `seeking` : le réseau travaille.
    Object.assign(video, { seeking: true });
    setTime(video, 900);
    internals.watchForStall();
    after(3000);
    after(3000);
    expect(onStall).not.toHaveBeenCalled();

    // Le même `seeking`, média sous la tête : ce n'est plus le réseau, c'est un saut qui ne se
    // résout pas, et il s'écrit.
    setTime(video, 5);
    internals.watchForStall();
    after(3000);
    after(2500);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("écrit une horloge qui avance sans rien sous la tête", async () => {
    // 22/09/2026, iPhone : « le temps avance de plusieurs dizaines de secondes, pas d'image, et ça
    // ne s'arrête pas tant que je ne ressaute pas ». Une horloge qui court n'est pas un blocage aux
    // yeux de la ligne `stall` : rien ne l'écrivait.
    const video = fakeVideo();
    Object.assign(video, { seeking: false });
    const onStall = vi.fn();
    const remuxer = fakeRemuxer(500);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onStall });
    const internals = internalsOf(mse);
    await until(() => internals.fillTask === null && video.buffered.length > 0, "le premier remplissage est fini");
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    vi.useFakeTimers({ toFake: ["Date"] });

    // Bien au-delà du média, et l'horloge avance.
    let at = 400;
    setTime(video, at);
    internals.watchForStall();
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(Date.now() + 250);
      at += 0.25;
      setTime(video, at);
      internals.watchForStall();
    }
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toMatchObject({ runaway: true });
    expect(onStall.mock.calls[0][0].steps).toContain("horloge qui avance sans média");
    // Et ce n'est plus seulement écrit : la position est redemandée, tampons vidés et relus.
    // Aucune autre surveillance ne le voyait — une lecture était en cours, la tête était « au
    // bord » du média, et l'horloge bougeait.
    await flush();
    expect(remuxer.seeks.length).toBeGreaterThan(0);
  });
});

describe("MseSource sur un élément qui refuse srcObject", () => {
  let created: string[];
  let revoked: string[];

  beforeEach(() => {
    created = [];
    revoked = [];
    vi.stubGlobal("URL", {
      createObjectURL: () => {
        const url = `blob:mse-${created.length}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    });
  });

  // Le symptôme tel qu'il se lisait en production : `GET blob:https://…/<uuid>
  // net::ERR_FILE_NOT_FOUND` dans la console, à chaque fermeture du lecteur natif. Ce n'était
  // pas quelque chose qui revenait tardivement sur une URL morte — c'était le nettoyage
  // lui-même qui la redemandait, ayant révoqué avant de retirer l'attribut.
  it("ne redemande pas l'URL qu'il vient de révoquer", async () => {
    const fetched: string[] = [];
    const video = videoRefusingSrcObject(fetched);
    const mse = await MseSource.attach(video, fakeRemuxer(50), PLAN, { onError: vi.fn() });
    await flush();

    // Sans cela le banc passerait en ne prouvant rien : c'est la branche à URL qui est en cause.
    expect(created).toHaveLength(1);
    expect((video as unknown as { src: string }).src).toBe(created[0]);

    mse.destroy();

    expect(revoked).toEqual(created);
    expect(fetched.filter((url) => revoked.includes(url))).toEqual([]);
    expect((video as unknown as { src: string }).src).toBe("");
  });
});


// Trois « Media failed to decode » sur un iPhone 12 (23/09/2026) n'ont laissé au journal que leur
// motif : la ligne `rebuild` est écrite au prochain envoi refusé, quand les tampons sont déjà
// détachés. L'état est donc relevé à l'erreur de l'élément, et c'est celui-là qu'on rapporte.
describe("lossReport", () => {
  it("rapporte les tampons tels qu'ils étaient à l'erreur, et la trace qui y mène", async () => {
    const video = fakeVideo();
    const mse = await MseSource.attach(video, fakeRemuxer(40), PLAN, { onError: vi.fn() });
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 4, "du média devant la tête");

    video.dispatchEvent(new Event("error"));
    // Puis la plateforme ferme la source : les tampons ne se lisent plus.
    const source = FakeSource.instances.at(-1)!;
    source.readyState = "closed";
    for (const buffer of source.buffers) {
      Object.defineProperty(buffer, "buffered", {
        get: () => {
          throw new DOMException("removed", "InvalidStateError");
        },
      });
    }

    const report = mse.lossReport();
    expect(report.videoBuffered).toMatch(/^0\.00–/);
    expect(report.source).toBe("open");
    expect(String(report.steps)).toContain("l'élément a échoué");
    mse.destroy();
  });

  it("se contente de l'état présent quand aucune erreur n'a été vue", async () => {
    const video = fakeVideo();
    const mse = await MseSource.attach(video, fakeRemuxer(40), PLAN, { onError: vi.fn() });
    await until(() => video.buffered.length > 0, "du média");
    expect(mse.lossReport()).toEqual(expect.objectContaining({ position: expect.any(Number), steps: expect.any(String) }));
    mse.destroy();
  });
});

// Chasse aux bugs du 24/09/2026.
describe("relu le 24/09/2026", () => {
  type Internals = {
    watchdogTimer: ReturnType<typeof setInterval> | null;
    watchForStall: () => void;
    pendingStart: number | null;
  };

  // Une ouverture en cours de film attend son premier média la tête à zéro : ce n'est pas un
  // blocage, c'est le réseau (Love Story, 23/09 : un « stall » à 0 s pour une ouverture lente).
  it("n'écrit pas de blocage pendant qu'une ouverture attend son média", async () => {
    const video = fakeVideo();
    Object.assign(video, { readyState: 0, networkState: 2, seeking: false });
    const onStall = vi.fn();
    // Rien n'arrive : le lecteur est pointé sur 1200 s et n'a encore rien envoyé.
    const remuxer = Object.assign(fakeRemuxer(500), { nextSegment: () => new Promise<null>(() => {}) });
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onStall }, 1200);
    const internals = mse as unknown as Internals;
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    expect(internals.pendingStart).toBe(1200);
    vi.useFakeTimers({ toFake: ["Date"] });
    internals.watchForStall();
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(Date.now() + 1000);
      internals.watchForStall();
    }
    expect(onStall).not.toHaveBeenCalled();
    vi.useRealTimers();
    mse.destroy();
  });

  // Un saut qui attend une lecture réseau pendant qu'une reconstruction détruit la source : il ne
  // doit plus toucher l'élément, que le lecteur suivant est en train d'ouvrir.
  it("ne déplace plus l'élément une fois détruite", async () => {
    const video = fakeVideo();
    // Le saut attend la lecture en cours : c'est pendant cette attente que la source part. La
    // lecture est tenue jusqu'à la destruction plutôt que de durer 30 ms — sous la charge de la
    // construction de l'image, 30 ms s'écoulaient avant la destruction et le test échouait sans que
    // rien n'ait changé (24/09/2026).
    // Le premier segment passe ; la lecture du deuxième reste en cours jusqu'à la destruction.
    const remuxer = fakeRemuxer(500, 0.2, true);
    const read = remuxer.nextSegment.bind(remuxer);
    let reads = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    remuxer.nextSegment = async () => {
      reads += 1;
      if (reads > 1) await held;
      return read();
    };
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await until(() => video.buffered.length > 0 && reads > 1, "du média, et une lecture en cours");
    const seeking = mse.seek(900);
    await flush();
    mse.destroy();
    release();
    await seeking;
    expect(video.currentTime).not.toBeCloseTo(900, 0);
  });
});

// Le média lu avant la cible d'un saut ne la couvre pas, et n'a pas à le faire : il n'est pas
// « rien retenu » (relu le 24/09/2026).
describe("la lecture d'avance d'un saut", () => {
  it("ne compte pas comme un refus du navigateur", async () => {
    const video = fakeVideo();
    // Un saut qui repart 18 s avant sa cible — un index qui ment — et lit par tranches de 2 s.
    let base = 0;
    let index = 0;
    const seeks: number[] = [];
    const remuxer = Object.assign(fakeRemuxer(500), {
      seeks,
      seekTo: (at: number) => {
        seeks.push(at);
        base = Math.max(0, at - 18);
        index = 0;
      },
      nextSegment: async () => {
        index += 1;
        const endSeconds = base + index * 2;
        // Passé la cible, le média la couvre, comme dans un vrai tampon.
        if (endSeconds > 100) for (const buffer of FakeSource.instances[0].buffers) buffer.coversNothing = false;
        return { video: [new Uint8Array([index])], audio: new Uint8Array([index]), subtitles: [], endSeconds };
      },
    });
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await until(() => video.buffered.length > 0, "du média");
    // Rien ne couvre la cible tant que la lecture d'avance ne l'a pas atteinte.
    for (const buffer of FakeSource.instances[0].buffers) buffer.coversNothing = true;
    await mse.seek(100);
    await until(() => index >= 14, "la lecture d'avance, puis la cible");
    // Pas de reprise : une seule demande de lecture, celle du saut.
    expect(seeks.filter((at) => at > 50)).toHaveLength(1);
    mse.destroy();
  });
});

// Une image figée, média sous la tête : l'échelle doit monter, pas recommencer ses poussées après
// chaque reprise (relu le 24/09/2026 — 62 s avant le lecteur serveur, 21 s une fois corrigé).
describe("une image figée qui ne repart pas", () => {
  it("gravit l'échelle jusqu'à céder la main en moins de 40 s", async () => {
    const video = fakeVideo();
    const remuxer = Object.assign(fakeRemuxer(5000, 0.2), { keyframeAfter: (s: number) => s + 3 });
    const onError = vi.fn();
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError, onWarning: vi.fn() });
    const internals = mse as unknown as { watchdog: () => void; watchdogTimer: ReturnType<typeof setInterval> | null; fillTask: Promise<void> | null };
    await until(() => internals.fillTask === null && video.buffered.length > 0 && video.buffered.end(0) > 5, "le remplissage");
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    Object.assign(video, { seeking: false });
    (video as unknown as { currentTime: number }).currentTime = 0.25;
    video.dispatchEvent(new Event("play"));
    vi.useFakeTimers({ toFake: ["Date"] });
    let ms = 0;
    for (; ms < 40_000 && onError.mock.calls.length === 0; ms += 250) {
      vi.setSystemTime(Date.now() + 250);
      internals.watchdog();
      await flush();
      await flush();
      await until(() => internals.fillTask === null, "le remplissage d'après reprise");
    }
    vi.useRealTimers();
    expect(onError).toHaveBeenCalled();
    mse.destroy();
  }, 60_000);
});

// Une coupure réseau pendant qu'il reste de l'avance : le tampon est gardé, la lecture reprend là
// où elle s'était arrêtée (relu le 24/09/2026 — un redéploiement vidait trente secondes d'image).
describe("une coupure réseau avec de l'avance", () => {
  const networkError = () => Object.assign(new Error("Load failed"), { network: true });
  afterEach(() => vi.useRealTimers());

  it("garde le tampon, retire seulement ce qui sera relu, et reprend", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const video = fakeVideo();
    const onError = vi.fn();
    let index = 0;
    let failOnce = false;
    const seeks: number[] = [];
    const remuxer = Object.assign(fakeRemuxer(500), {
      seeks,
      seekTo: (at: number) => {
        seeks.push(at);
        index = Math.floor(at / 2);
      },
      diagnostics: () => ({ presentationDelaySeconds: 0.2, clampedSamples: 0, segmentStartSeconds: index * 2 }),
      nextSegment: async () => {
        if (failOnce) {
          failOnce = false;
          throw networkError();
        }
        index += 1;
        return { video: [new Uint8Array([index])], audio: new Uint8Array([index]), subtitles: [], endSeconds: index * 2 };
      },
    });
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError });
    await vi.waitFor(() => expect(video.buffered.length > 0 && video.buffered.end(0) > 10).toBe(true));
    const buffers = FakeSource.instances[0].buffers;
    const removedBefore = buffers.map((b) => b.removed.length);
    const seeksBefore = seeks.length;

    // La prochaine lecture échoue, avec largement plus de 5 s d'avance sous la tête.
    failOnce = true;
    (video as unknown as { currentTime: number }).currentTime = 1;
    await (mse as unknown as { fill: () => Promise<void> }).fill();
    // Rien de vidé, pas de saut : le film continue sur ce qu'il a.
    expect(buffers.map((b) => b.removed.length)).toEqual(removedBefore);
    expect(seeks.length).toBe(seeksBefore);
    // Et rien n'est lu avant le nouvel essai, qui repositionne d'abord le lecteur de fichier.
    const readsBefore = index;
    await (mse as unknown as { fill: () => Promise<void> }).fill();
    expect(index).toBe(readsBefore);

    await vi.advanceTimersByTimeAsync(1100);
    // La lecture a repris là où elle s'était arrêtée, sans passer par une reprise…
    expect(seeks.length).toBe(seeksBefore + 1);
    // …et seul ce qui allait être relu a été retiré, jamais depuis zéro.
    const removals = buffers.flatMap((b) => b.removed.slice(removedBefore[buffers.indexOf(b)]));
    expect(removals.length).toBeGreaterThan(0);
    for (const [from] of removals) expect(from).toBeGreaterThan(1);
    expect(onError).not.toHaveBeenCalled();
    mse.destroy();
    vi.useRealTimers();
  });

  // Le groupe relu commence sous la tête (un groupe de 25 s, un nouvel essai tardif) : le retirer
  // enlèverait l'image en cours. La reprise habituelle, plutôt.
  it("ne retire jamais le média sous la tête", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const video = fakeVideo();
    let index = 0;
    let failOnce = false;
    const seeks: number[] = [];
    const remuxer = Object.assign(fakeRemuxer(500), {
      seeks,
      seekTo: (at: number) => {
        seeks.push(at);
        index = Math.floor(at / 2);
      },
      // Le groupe relu commence au tout début : bien avant la tête.
      diagnostics: () => ({ presentationDelaySeconds: 0.2, clampedSamples: 0, segmentStartSeconds: 0 }),
      nextSegment: async () => {
        if (failOnce) {
          failOnce = false;
          throw networkError();
        }
        index += 1;
        return { video: [new Uint8Array([index])], audio: new Uint8Array([index]), subtitles: [], endSeconds: index * 2 };
      },
    });
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await vi.waitFor(() => expect(video.buffered.length > 0 && video.buffered.end(0) > 10).toBe(true));
    const buffers = FakeSource.instances[0].buffers;
    const removedBefore = buffers.map((b) => b.removed.length);
    failOnce = true;
    (video as unknown as { currentTime: number }).currentTime = 5;
    await (mse as unknown as { fill: () => Promise<void> }).fill();
    await vi.advanceTimersByTimeAsync(1100);
    // Aucun retrait partiel sous la tête : soit rien, soit le vidage complet d'une reprise.
    const removals = buffers.flatMap((b, i) => b.removed.slice(removedBefore[i]));
    for (const [from] of removals) expect(from === 0 || from > 5).toBe(true);
    expect(traceText()).toContain("sous la tête — reprise habituelle");
    mse.destroy();
  });

  it("vide et reprend comme avant quand il ne reste presque rien", async () => {
    const video = fakeVideo();
    let failNext = false;
    const remuxer = Object.assign(fakeRemuxer(500), {
      nextSegment: async () => {
        if (failNext) {
          failNext = false;
          throw networkError();
        }
        return { video: [new Uint8Array([1])], audio: new Uint8Array([1]), subtitles: [], endSeconds: 2 };
      },
    });
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await until(() => video.buffered.length > 0, "du média");
    const internals = mse as unknown as { lead: number; fill: () => Promise<void>; fillTask: Promise<void> | null };
    await until(() => internals.fillTask === null, "le remplissage");
    // La tête au bout du média : moins de 5 s d'avance.
    (video as unknown as { currentTime: number }).currentTime = video.buffered.end(0) - 1;
    const seeksBefore = remuxer.seeks.length;
    failNext = true;
    await internals.fill();
    await flush();
    expect(remuxer.seeks.length).toBeGreaterThan(seeksBefore);
    mse.destroy();
  });
});

// Fuzz du 24/09/2026 (graine 30054481) : pendant qu'un saut est servi, le spectateur saute dans une
// zone encore dans le tampon. Le raccourci « déjà chargé » ne demandait rien, puis le saut en cours
// vidait les tampons et ramenait la tête sur sa propre cible : le dernier geste était perdu.
describe("un saut dans le tampon pendant qu'un autre est servi", () => {
  it("laisse le dernier geste l'emporter", async () => {
    const video = fakeVideo();
    // Comme un vrai élément : écrire `currentTime` — y compris quand c'est la source qui le fait —
    // déclenche `seeking`. C'est ce `seeking`-là qui effaçait la cible du spectateur.
    let head = 0;
    Object.defineProperty(video, "currentTime", {
      get: () => head,
      set: (t: number) => {
        head = t;
        queueMicrotask(() => video.dispatchEvent(new Event("seeking")));
      },
      configurable: true,
    });
    const mse = await MseSource.attach(video, fakeRemuxer(500, 0.2, true, 30), PLAN, { onError: vi.fn() });
    const internals = mse as unknown as { watchdogTimer: ReturnType<typeof setInterval> | null };
    // Sans le chien de garde : c'est le saut lui-même qui doit servir le dernier geste, pas un
    // rattrapage une demi-seconde plus tard.
    if (internals.watchdogTimer) clearInterval(internals.watchdogTimer);
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 8, "du média");
    const setTime = (t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

    // Un saut loin, hors du tampon : il attend la lecture en cours avant d'être servi…
    setTime(900);
    await Promise.resolve();
    // …et le doigt revient aussitôt dans ce qui est encore chargé.
    setTime(5);

    await until(() => !mse.seekPending || video.currentTime !== 900, "le saut servi", 3000);
    await new Promise((r) => setTimeout(r, 200));
    expect(video.currentTime).toBeCloseTo(5, 0);
    mse.destroy();
  });
});

/**
 * Ce que Safari retire de lui-même (24/09/2026).
 *
 * Trois sauts « dans le chargé » ont trouvé leur cible vide 0,7 s plus tard, sans qu'on puisse
 * dire si c'était le système ou ce lecteur. ManagedMediaSource le dit par `bufferedchange` : le
 * lecteur l'écrit, le compte, et relit tout de suite ce qui manque devant la tête.
 */
describe("les évictions du navigateur", () => {
  type Facts = { recoveryFacts: { evictions: number; evictionsAhead: number } };
  const setTime = (video: HTMLVideoElement, t: number) => ((video as unknown as { currentTime: number }).currentTime = t);

  it("écrit ce que le navigateur retire, et ne compte pas ses propres retraits", async () => {
    FakeBuffer.managed = true;
    const video = fakeVideo();
    const remuxer = fakeRemuxer(200);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 20, "du média devant la tête");
    // Un saut : ce lecteur vide ses deux tampons, et le système l'annonce comme tout retrait.
    await mse.seek(40);
    await until(() => video.buffered.length > 0 && video.buffered.end(0) > 60, "le saut rempli");
    expect((mse as unknown as Facts).recoveryFacts.evictions).toBe(0);
    expect(traceText()).not.toContain("le navigateur a retiré");

    // Derrière la tête : noté, rien à relire.
    setTime(video, 50);
    const seeks = remuxer.seeks.length;
    FakeSource.instances[0].buffers[0].systemEvicts(40, 45);
    await flush();
    expect(traceText()).toContain("le navigateur a retiré vidéo 40.00–45.00 — tête à 50.0 s");
    expect((mse as unknown as Facts).recoveryFacts).toMatchObject({ evictions: 1, evictionsAhead: 0 });
    expect(remuxer.seeks).toHaveLength(seeks);
    mse.destroy();
  });

  it("relit tout de suite ce qui manque devant la tête, sans toucher à ce qui est dessous", async () => {
    FakeBuffer.managed = true;
    const video = fakeVideo();
    const onError = vi.fn();
    let index = 0;
    const seeks: number[] = [];
    const remuxer = Object.assign(fakeRemuxer(500), {
      seeks,
      seekTo: (at: number) => {
        seeks.push(at);
        index = Math.floor(at / 2);
      },
      diagnostics: () => ({ presentationDelaySeconds: 0.2, clampedSamples: 0, segmentStartSeconds: index * 2 }),
      nextSegment: async () => {
        index += 1;
        return { video: [new Uint8Array([index])], audio: new Uint8Array([index]), subtitles: [], endSeconds: index * 2 };
      },
    });
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError });
    const internals = mse as unknown as { fillTask: Promise<void> | null };
    await until(() => internals.fillTask === null && video.buffered.length > 0 && video.buffered.end(0) >= 30, "le premier remplissage est fini");
    setTime(video, 2);
    const buffers = FakeSource.instances[0].buffers;
    const removedBefore = buffers.map((b) => b.removed.length);

    // Le système retire les douze dernières secondes de l'image : l'avance tombe de 30 à 18 s.
    buffers[0].systemEvicts(20, 40);
    await until(() => seeks.length > 0, "le lecteur de fichier renvoyé au trou");
    // Au début du trou, sur l'horloge du fichier…
    expect(seeks[0]).toBeCloseTo(19.8, 5);
    expect(traceText()).toContain("devant elle dès 20.0 s");
    expect(traceText()).toContain("relecture de ce que le navigateur a retiré, depuis 20.0 s");
    await until(() => internals.fillTask === null && buffers[0].appended.length > 20, "la relecture envoyée");
    // …et rien n'a été retiré sous la tête : seulement ce qui allait être relu.
    const removals = buffers.flatMap((b, i) => b.removed.slice(removedBefore[i]));
    expect(removals.length).toBeGreaterThan(0);
    for (const [from] of removals) expect(from).toBeGreaterThan(2);
    // Le retrait de la relecture est le sien : il ne compte pas comme une éviction.
    expect((mse as unknown as Facts).recoveryFacts).toMatchObject({ evictions: 1, evictionsAhead: 1 });
    expect(onError).not.toHaveBeenCalled();
    mse.destroy();
  });

  it("ne relit pas plus de trois fois par minute un système qui retire à mesure", async () => {
    FakeBuffer.managed = true;
    const video = fakeVideo();
    const remuxer = fakeRemuxer(2000);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    const internals = mse as unknown as { fillTask: Promise<void> | null };
    await until(() => internals.fillTask === null && video.buffered.length > 0 && video.buffered.end(0) >= 30, "le premier remplissage est fini");
    traceReset();
    for (let i = 0; i < 5; i++) {
      const end = video.buffered.end(0);
      FakeSource.instances[0].buffers[0].systemEvicts(end - 5, end);
      await until(() => internals.fillTask === null, "la relecture finie");
      await flush();
    }
    expect(traceText().match(/relecture de ce que le navigateur a retiré/g)?.length ?? 0).toBeLessThanOrEqual(3);
    expect(traceText()).toContain("retraits répétés");
    mse.destroy();
  });

  it("ne s'abonne à rien sur une MediaSource ordinaire", async () => {
    const video = fakeVideo();
    const mse = await MseSource.attach(video, fakeRemuxer(50), PLAN, { onError: vi.fn() });
    await until(() => video.buffered.length > 0, "du média");
    FakeSource.instances[0].buffers[0].systemEvicts(0, 4);
    await flush();
    expect((mse as unknown as Facts).recoveryFacts.evictions).toBe(0);
    mse.destroy();
  });
});
