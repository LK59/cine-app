// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MseSource } from "@/lib/webcodecs/mseSource";
import { RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";
import type { ChosenPath } from "@/lib/webcodecs/pathSelector";
import type { Remuxer, RemuxPlan } from "@/lib/webcodecs/remuxer";

// The failure this file is about is not hypothetical, and it is not reachable on the machines the
// player is developed on: `codecSupport.ts` records that `MediaSource.isTypeSupported` has false
// positives on some Firefox/Windows builds — it claims a codec and then refuses to attach a
// SourceBuffer for it. `addSourceBuffer` throwing is therefore the *normal* way this path fails on
// one of the declared targets, and what it used to leave behind was an audio decoder, an audio
// encoder, an open connection and a MediaSource kept alive by its own blob: URL, for the lifetime
// of a PWA nobody reloads.

const PLAN: RemuxPlan = {
  videoMimeType: 'video/mp4; codecs="hvc1.2.4.L150.90"',
  audioMimeType: 'audio/mp4; codecs="mp4a.40.2"',
  videoInit: new Uint8Array([1]),
  audioInit: new Uint8Array([2]),
  durationSeconds: 3600,
};

const REFUSAL = new DOMException("Unsupported MIME type", "NotSupportedError");

/** A MediaSource that opens normally and then refuses the buffer, as that Firefox build does. */
class RefusingSource extends EventTarget {
  static instances: RefusingSource[] = [];
  static isTypeSupported = () => true;
  readyState: "closed" | "open" | "ended" = "closed";
  duration = NaN;
  endedTimes = 0;

  constructor() {
    super();
    RefusingSource.instances.push(this);
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }
  addSourceBuffer(): SourceBuffer {
    throw REFUSAL;
  }
  removeSourceBuffer() {}
  endOfStream() {
    this.endedTimes += 1;
    this.readyState = "ended";
  }
}

/**
 * An element that refuses `srcObject`, which is what forces the object-URL branch.
 *
 * The preferred branch hands the source object straight to the element and has no URL to leak;
 * the leak being guarded against only exists on the fallback, so the bench has to be on it.
 */
function videoWithoutSrcObject() {
  const target = new EventTarget();
  let playhead = 0;
  Object.defineProperty(target, "currentTime", {
    get: () => playhead,
    set: (v: number) => {
      playhead = v;
    },
    configurable: true,
  });
  Object.defineProperty(target, "buffered", { get: () => ({ length: 0 }), configurable: true });
  Object.defineProperty(target, "srcObject", {
    get: () => null,
    set: () => {
      throw new Error("srcObject unsupported");
    },
    configurable: true,
  });
  return Object.assign(target, {
    paused: true,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    disableRemotePlayback: false,
    src: "",
    removeAttribute: vi.fn(function (this: { src: string }) {
      this.src = "";
    }),
  }) as unknown as HTMLVideoElement;
}

function fakeRemuxer() {
  return {
    seekable: true,
    plan: () => PLAN,
    setAudioTrack: async () => {},
    setVideoWanted: () => {},
    diagnostics: () => ({ presentationDelaySeconds: 0, clampedSamples: 0 }),
    seekTo: () => {},
    nextSegment: async () => null,
    close: vi.fn(),
  };
}

let created: string[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  RefusingSource.instances = [];
  vi.stubGlobal("ManagedMediaSource", RefusingSource);
  vi.stubGlobal("MediaSource", RefusingSource);
  vi.stubGlobal("URL", {
    createObjectURL: () => {
      const url = `blob:refused-${created.length}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("a MediaSource that refuses the buffer it said it supported", () => {
  it("releases the object URL rather than leaving the source alive behind it", async () => {
    const video = videoWithoutSrcObject();
    const remuxer = fakeRemuxer() as unknown as Remuxer;

    await expect(MseSource.attach(video, remuxer, PLAN, { onError: vi.fn() })).rejects.toThrow(
      /Unsupported MIME type/
    );

    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created);
    expect(video.src).toBe("");
  });

  it("closes the remuxer and the byte source when the attach inside start fails", async () => {
    const video = videoWithoutSrcObject();
    const remuxer = fakeRemuxer();
    const source = { size: 100, read: async () => new Uint8Array(), close: vi.fn() };
    const videoTrack = { number: 1, type: "video", codecId: "V_MPEGH/ISO/HEVC" } as unknown as MatroskaTrack;
    const file = { tracks: [videoTrack], cues: [] } as unknown as MatroskaFile;
    const chosen: ChosenPath = {
      path: "remux",
      remuxer: remuxer as unknown as Remuxer,
      plan: PLAN,
      attempts: [],
    };

    await expect(
      RemuxPlayback.start(video, source as unknown as ByteSource, file, videoTrack, null, chosen, {
        streamUrl: "http://example.test/film.mkv",
        startSeconds: 0,
        onError: vi.fn(),
      })
    ).rejects.toThrow(/Unsupported MIME type/);

    // The instance is never handed back, so nothing else could ever have freed these: the decoder
    // and encoder the remuxer holds, and the connection the source holds.
    expect(remuxer.close).toHaveBeenCalled();
    expect(source.close).toHaveBeenCalled();
    expect(revoked).toEqual(created);
  });
});
