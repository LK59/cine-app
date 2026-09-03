// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MseSource, playabilityOf } from "@/lib/webcodecs/mseSource";
import type { Remuxer, RemuxPlan, RemuxSegment } from "@/lib/webcodecs/remuxer";
import { traceText } from "@/lib/webcodecs/trace";

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

  constructor(readonly type: string) {
    super();
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
      const start = this.ranges.length > 0 ? this.ranges[0][0] : playhead + this.landsLate;
      const end = (this.ranges.length > 0 ? this.ranges[0][1] : playhead + this.landsLate) + this.secondsPerAppend;
      this.ranges = [[start, end]];
    }
    this.initSeen = true;
    this.finishSoon();
  }

  remove(start: number, end: number) {
    this.refuseIfBusy("remove");
    this.removed.push([start, end]);
    this.ranges = [];
    this.updating = true;
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

/** Shared so an appended range can begin where the reader was pointed, as a real buffer does. */
let playhead = 0;

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
    setAudioTrack: async () => {},
    // Recorded, not merely tolerated: whether the pictures are built at all is a real decision
    // the caller makes, and a bench that ignores it cannot show it being made wrongly.
    videoWantedCalls: [] as boolean[],
    setVideoWanted(wanted: boolean) {
      remuxer.videoWantedCalls.push(wanted);
    },
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
      // Every segment carries a line. Subtitles are read out of the same stretch of file as the
      // pictures, so a bench whose segments carry none cannot show them going missing when the
      // pictures stop being built.
      const subtitles = [
        { track: 4, startSeconds: index * 2, endSeconds: index * 2 + 1.5, text: `ligne ${index}` },
      ];
      return {
        video: remuxer.videoWantedCalls.at(-1) === false ? [] : [new Uint8Array([10 + index])],
        audio: new Uint8Array([20 + index]),
        subtitles,
        endSeconds: index * 2,
      };
    },
  };
  return remuxer as unknown as Remuxer & { seeks: number[]; videoWantedCalls: boolean[] };
}

beforeEach(() => {
  playhead = 0;
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
    await MseSource.attach(video, fakeRemuxer(200), PLAN, { onError });
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
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("index"));
    expect(onError).not.toHaveBeenCalled();
  });

  it("replaces the audio track's description without disturbing the video buffer", async () => {
    const video = fakeVideo();
    const mse = await MseSource.attach(video, fakeRemuxer(500), PLAN, { onError: vi.fn() });
    await flush();
    const [videoBuffer, audioBuffer] = FakeSource.instances[0].buffers;
    const videoAppends = videoBuffer.appended.length;

    await mse.replaceAudio(PLAN.audioMimeType, new Uint8Array([99]));
    // The picture must not stop for a language change: only the sound is re-described.
    expect(videoBuffer.appended.length).toBe(videoAppends);
    expect(videoBuffer.removed).toEqual([]);
    expect(audioBuffer.removed[0][0]).toBe(0);
    expect(Array.from(audioBuffer.appended[audioBuffer.appended.length - 1])).toEqual([99]);
  });

  it("starts reading where the viewer is resuming, not at the beginning of the file", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() }, 1200);
    await flush();
    // Filling thirty seconds from zero and then discarding all of it is what made resuming a
    // part-watched episode feel slow.
    expect(remuxer.seeks).toEqual([1200]);
    expect(video.currentTime).toBe(1200);
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
    expect(video.currentTime).toBe(600.2);
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
    // driven by unrelated events: a seek, a language change, the read loop, eviction. Firing
    // them into the same instant is what produced a freeze that a second seek then undid.
    await Promise.all([
      mse.seek(600),
      mse.replaceAudio(PLAN.audioMimeType, new Uint8Array([7])),
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

  it("survives a language change landing while the read loop is mid-append", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    const remuxer = fakeRemuxer(500, 0.2, true, 5);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError, onWarning: vi.fn() });
    await flush();
    for (const buffer of FakeSource.instances[0].buffers) buffer.busyMs = 6;

    // The reported freeze, in the order it was reported: seek, then change language before the
    // seek's refill has finished. Both reach for the audio buffer from different directions.
    void mse.seek(600);
    await new Promise((r) => setTimeout(r, 8));
    await mse.replaceAudio(PLAN.audioMimeType, new Uint8Array([7]));
    await new Promise((r) => setTimeout(r, 120));

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
    const remuxer = fakeRemuxer(500, 0.2);
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
    setTime(12.49);
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    await flush();

    expect(video.currentTime).toBe(12.49);
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
    expect(video.currentTime).toBe(12);
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
    expect(video.currentTime).toBe(12.2);

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

  it("changes the sound without sending the picture again", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const [videoBuffer, audioBuffer] = FakeSource.instances[0].buffers;
    const videoAppends = videoBuffer.appended.length;
    const audioAppends = audioBuffer.appended.length;

    await mse.refillAudio(10);
    await until(() => audioBuffer.appended.length > audioAppends, "le son est relu");

    // Re-appending video over media the browser has already played is what it catches up on at
    // speed: several seconds replayed in one or two, reported after every language change.
    expect(videoBuffer.removed).toEqual([]);
    expect(videoBuffer.appended.length).toBe(videoAppends);
    // The sound, meanwhile, really is replaced.
    expect(audioBuffer.removed.length).toBeGreaterThan(0);
    expect(audioBuffer.appended.length).toBeGreaterThan(audioAppends);
  });

  it("still holds on to the picture when the codec changed first", async () => {
    // The real sequence of a language change: the audio buffer is emptied for the new codec, and
    // only then is the sound read again. Between the two, the element's own ranges — which are
    // the intersection of the buffers — are empty at the playhead, and reading "how much do we
    // hold" from them says none. The picture was then appended again from the keyframe before
    // the playhead, under a decoder mid-frame: the picture froze while the sound played on.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const [videoBuffer, audioBuffer] = FakeSource.instances[0].buffers;
    const videoAppends = videoBuffer.appended.length;
    const audioAppends = audioBuffer.appended.length;

    await mse.replaceAudio('audio/mp4; codecs="mp4a.40.2"', new Uint8Array([7]));
    await mse.refillAudio(10);
    await until(() => audioBuffer.appended.length > audioAppends, "le son est relu");

    expect(videoBuffer.removed).toEqual([]);
    expect(videoBuffer.appended.length).toBe(videoAppends);
  });

  it("replaces the audio buffer rather than reinterpreting it, where the browser allows", async () => {
    // The third of three ways to change what the sound decodes by, and the only one that leaves
    // the element attached and the picture's buffer untouched. changeType is accepted on Safari
    // and then answered with a decode failure that closes the source.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const source = FakeSource.instances[0];
    const outgoing = source.buffers[1];
    mse.rebuildAudioAllowed = true;

    await mse.replaceAudio('audio/mp4; codecs="opus"', new Uint8Array([7]));

    expect(source.removed).toContain(outgoing);
    expect(outgoing.typeChangedAfter).toBe(-1); // never asked to reinterpret itself
    const incoming = source.buffers[source.buffers.length - 1];
    expect(incoming.type).toBe('audio/mp4; codecs="opus"');
    expect(incoming.appended.length).toBe(1); // its initialisation segment, and nothing else yet
    // The picture is untouched by any of it.
    expect(source.removed).not.toContain(source.buffers[0]);
  });

  it("does not build the pictures of a stretch the browser already holds", async () => {
    // A language change re-reads the file from the playhead. The bytes cannot be avoided — the
    // sound is interleaved with the pictures in the same clusters — but copying megabytes of
    // picture into segments that are then dropped can be, and on a 4K file that was five and
    // eight megabytes per segment for nothing.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    remuxer.videoWantedCalls.length = 0;

    // Asked for at least once while re-reading what is already held.
    await mse.refillAudio(10);
    await until(() => remuxer.videoWantedCalls.includes(false), "les images cessent d'être construites");

    // And an ordinary seek, which replaces everything, wants them all again.
    remuxer.videoWantedCalls.length = 0;
    await mse.seek(300);
    await until(() => remuxer.videoWantedCalls.length > 0, "le lecteur repart après le saut");
    expect(remuxer.videoWantedCalls).not.toContain(false);
  });

  it("still finds the subtitles while the pictures are not being built", async () => {
    // The lines are read out of the same stretch of file as the pictures. Skipping the picture is
    // an optimisation about copying, not about reading, and a change of language must not cost
    // the viewer their subtitles for the thirty seconds it re-reads.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const onSubtitles = vi.fn();
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn(), onSubtitles });
    await flush();
    onSubtitles.mockClear();

    await mse.refillAudio(10);
    await until(() => remuxer.videoWantedCalls.includes(false), "les images cessent d'être construites");
    await until(() => onSubtitles.mock.calls.length > 0, "des sous-titres sont trouvés");
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

  it("empties the audio buffer before asking it to change codec", async () => {
    // Asking a buffer to reinterpret itself while it still holds coded frames of the codec it is
    // leaving is more than the specification requires of an implementation — and this device
    // answered it with "media failed to decode", which closes the MediaSource and takes the
    // picture with it.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn() });
    await flush();
    const audioBuffer = FakeSource.instances[0].buffers[1];

    await mse.replaceAudio('audio/mp4; codecs="mp4a.40.2"', new Uint8Array([7]));
    expect(audioBuffer.typeChangedAfter).toBeGreaterThan(0);
  });

  it("stops the picture only once it would run on without sound", async () => {
    // Chrome stalls by itself when a buffer has nothing at the playhead; Safari plays the
    // picture on in silence. Stopping the element up front fixed the second and cost the first a
    // visible pause on every change of track, so nothing happens until the picture is actually
    // moving with no sound under it.
    const video = fakeVideo();
    const remuxer = fakeRemuxer(500, 0.2);
    const onStarting = vi.fn();
    const mse = await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn(), onWarning: vi.fn(), onStarting });
    await flush();
    const audioBuffer = FakeSource.instances[0].buffers[1];

    mse.beginAudioHold();
    await new Promise((r) => setTimeout(r, 100));
    // The outgoing track still covers the playhead: nothing to prevent, nothing done.
    expect(video.paused).toBe(false);

    // Now it does not.
    (audioBuffer as unknown as { ranges: [number, number][] }).ranges = [];
    await until(() => video.paused, "l'image est retenue");
    expect(onStarting).toHaveBeenLastCalledWith(expect.any(Number));

    // And a press of play into that gap is remembered, not obeyed.
    (video as unknown as { paused: boolean }).paused = false;
    video.dispatchEvent(new Event("play"));
    expect(video.paused).toBe(true);

    mse.releaseAudioHold();
    expect(video.paused).toBe(false);
    expect(onStarting).toHaveBeenLastCalledWith(null);
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
    const stuck = { plan: () => PLAN, seekable: true, seeks: [], diagnostics: () => ({ presentationDelaySeconds: 0.2, clampedSamples: 0 }), seekTo: () => {}, setAudioTrack: async () => {}, setVideoWanted: () => {}, nextSegment: () => new Promise(() => {}) };
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
