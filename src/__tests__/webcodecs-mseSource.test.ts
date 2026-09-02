// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MseSource, playabilityOf } from "@/lib/webcodecs/mseSource";
import type { Remuxer, RemuxPlan, RemuxSegment } from "@/lib/webcodecs/remuxer";

// MediaSource does not exist in jsdom, and the parts of it that matter here — when a buffer
// signals it is done, when the system asks for data, what happens when it is full — are exactly
// the parts a real browser would only exercise on a device. So they are modelled explicitly.

class FakeBuffer extends EventTarget {
  mode = "sequence";
  updating = false;
  appended: Uint8Array[] = [];
  removed: [number, number][] = [];
  aborted = 0;
  /** Set to make the next append throw as a full buffer does. */
  quotaOnNextAppend = false;
  /** Set to make the next append fail the way a segment the decoder rejects does. */
  failOnNextAppend = false;
  /** Each media segment carries this much, so the buffer grows as it would in a browser. */
  secondsPerAppend = 2;
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

  appendBuffer(data: Uint8Array) {
    if (this.quotaOnNextAppend) {
      this.quotaOnNextAppend = false;
      throw new DOMException("full", "QuotaExceededError");
    }
    this.appended.push(data);
    this.updating = true;
    // A buffer that always reports itself empty would let the fill loop run away; growing it is
    // what makes "stop once far enough ahead" testable at all.
    const start = this.ranges.length > 0 ? this.ranges[0][0] : 0;
    const end = (this.ranges.length > 0 ? this.ranges[0][1] : 0) + this.secondsPerAppend;
    this.ranges = [[start, end]];
    queueMicrotask(() => {
      this.updating = false;
      if (this.failOnNextAppend) {
        this.failOnNextAppend = false;
        this.dispatchEvent(new Event("error"));
      } else {
        this.dispatchEvent(new Event("updateend"));
      }
    });
  }

  remove(start: number, end: number) {
    this.removed.push([start, end]);
    this.ranges = [];
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }

  abort() {
    this.aborted += 1;
  }
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
  addSourceBuffer(type: string) {
    const buffer = new FakeBuffer(type);
    this.buffers.push(buffer);
    return buffer as unknown as SourceBuffer;
  }
  endOfStream() {
    this.endedTimes += 1;
    this.readyState = "ended";
  }
}

function fakeVideo() {
  const target = new EventTarget();
  return Object.assign(target, {
    currentTime: 0,
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

function fakeRemuxer(segments: number, delay = 0.2, seekable = true) {
  let index = 0;
  const seeks: number[] = [];
  const remuxer = {
    seeks,
    seekable,
    plan: () => PLAN,
    setAudioTrack: async () => {},
    diagnostics: () => ({ presentationDelaySeconds: delay, clampedSamples: 0 }),
    seekTo: (s: number) => {
      seeks.push(s);
      index = 0;
    },
    nextSegment: async (): Promise<RemuxSegment | null> => {
      if (index >= segments) return null;
      index += 1;
      return { video: new Uint8Array([10 + index]), audio: new Uint8Array([20 + index]), subtitles: [], endSeconds: index * 2 };
    },
  };
  return remuxer as unknown as Remuxer & { seeks: number[] };
}

beforeEach(() => {
  FakeSource.instances = [];
  FakeSource.supported = new Set([PLAN.videoMimeType, PLAN.audioMimeType!]);
  vi.stubGlobal("ManagedMediaSource", FakeSource);
  vi.stubGlobal("MediaSource", FakeSource);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

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

  it("leaves the file alone while the system says it does not want data", async () => {
    const video = fakeVideo();
    const remuxer = fakeRemuxer(100);
    const source = new FakeSource();
    source.streaming = false;
    FakeSource.instances = [];
    // Re-attach with a source that reports it is not streaming from the outset.
    class NotStreaming extends FakeSource {
      streaming = false;
    }
    vi.stubGlobal("ManagedMediaSource", NotStreaming);
    await MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() });
    await flush();
    // Only the two initialisation segments, no media.
    const buffers = FakeSource.instances[0].buffers;
    expect(buffers[0].appended.length).toBe(1);
    expect(buffers[1].appended.length).toBe(1);
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
    expect(videoBuffer.removed).toContainEqual([0, Infinity]);
    expect(audioBuffer.removed).toContainEqual([0, Infinity]);
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

    // A full buffer is a condition to manage, not a fault to surface.
    expect(onError).not.toHaveBeenCalled();
    expect(buffer.removed.some(([start, end]) => start === 0 && end === 70)).toBe(true);
  });

  it("reports a rejected segment rather than stalling on it", async () => {
    const video = fakeVideo();
    const onError = vi.fn();
    await MseSource.attach(video, fakeRemuxer(200), PLAN, { onError });
    await flush();

    const buffer = FakeSource.instances[0].buffers[0];
    buffer.failOnNextAppend = true;
    (video as unknown as { currentTime: number }).currentTime = 30;
    video.dispatchEvent(new Event("timeupdate"));
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("refusé"));
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
    expect(FakeSource.instances[0].buffers[0].removed).toContainEqual([0, Infinity]);
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
    expect(audioBuffer.removed).toContainEqual([0, Infinity]);
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
    // than the playhead, and the element would otherwise wait there indefinitely.
    (video as unknown as { currentTime: number }).currentTime = 600;
    buffer.setBuffered(600.2, 620);
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
