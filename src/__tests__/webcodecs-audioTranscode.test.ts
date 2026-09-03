import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Choosing what to re-encode to now asks the browser what it will accept back in a MediaSource,
// so there has to be one to ask. This stands in for a player that takes anything.
beforeEach(() => {
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
});
afterEach(() => vi.unstubAllGlobals());

// The sound path for codecs that cannot ride in the container at all. What matters here is the
// plumbing — what is asked of the browser, what is done with a refusal, and how frames are cut
// into segments — since the encoding itself is the browser's and cannot be exercised in a test.

const samples = vi.fn();
const close = vi.fn();
vi.mock("@/lib/webcodecs/softwareAudio", () => ({
  SoftwareAudioTrack: {
    open: vi.fn(async () => ({
      format: { sampleRate: 48000, numberOfChannels: 6 },
      samples,
      close,
    })),
  },
}));

/** Decoded blocks of 512 frames, as a DTS decoder hands them over. */
function decoded(count: number, fromSeconds = 0) {
  return (async function* () {
    for (let i = 0; i < count; i++) {
      yield {
        planes: Array.from({ length: 6 }, () => new Float32Array(512)),
        sampleRate: 48000,
        timestampSeconds: fromSeconds + (i * 512) / 48000,
      };
    }
  })();
}

class FakeAudioData {
  constructor(readonly init: { numberOfFrames: number; sampleRate: number; timestamp: number }) {}
  close() {}
}

/** Emits fixed 1024-frame chunks and buffers the remainder, as a real AAC encoder does. */
function fakeEncoderClass(options: { describeAfter?: number; failWith?: string } = {}) {
  return class {
    static supportedCalls: unknown[] = [];
    static async isConfigSupported(config: unknown) {
      this.supportedCalls.push(config);
      return { supported: true, config };
    }
    state = "unconfigured";
    encodeQueueSize = 0;
    private held = 0;
    private heldFrom = 0;
    private emitted = 0;
    constructor(private readonly init: { output: (c: unknown, m?: unknown) => void; error: (e: unknown) => void }) {
      if (options.failWith) queueMicrotask(() => init.error({ message: options.failWith } as never));
    }
    configure() {
      this.state = "configured";
    }
    encode(data: FakeAudioData) {
      // Whole frames go out as they are completed, as a real encoder hands them back; only the
      // remainder waits, and only a flush can make it come out early.
      if (this.held === 0) this.heldFrom = data.init.timestamp;
      this.held += data.init.numberOfFrames;
      while (this.held >= 1024) {
        this.emit({ timestamp: this.heldFrom, duration: Math.round((1024 / 48000) * 1e6) });
        this.heldFrom += Math.round((1024 / 48000) * 1e6);
        this.held -= 1024;
      }
    }
    private emit(q: { timestamp: number; duration: number }) {
      const describe = this.emitted >= (options.describeAfter ?? 0);
      this.emitted += 1;
      this.init.output(
        { ...q, byteLength: 8, copyTo: (d: Uint8Array) => d.fill(7) },
        describe ? { decoderConfig: { description: new Uint8Array([0x11, 0xb0]) } } : undefined
      );
    }
    async flush() {
      // Padding out what did not fill a frame — the very thing this is no longer asked to do
      // between segments.
      if (this.held > 0) {
        this.emit({ timestamp: this.heldFrom, duration: Math.round((1024 / 48000) * 1e6) });
        this.held = 0;
      }
    }
    reset() {
      this.held = 0;
      this.state = "unconfigured";
    }
    close() {}
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("AudioData", FakeAudioData);
});
afterEach(() => vi.unstubAllGlobals());

const track = { number: 2, codecId: "A_DTS", language: "fra", audio: { sampleRate: 48000, channels: 6 } };
const source = { size: 1, read: async () => new Uint8Array(0), close: () => {} };

async function load() {
  return import("@/lib/webcodecs/audioTranscode");
}

describe("transcodableAudio", () => {
  it("names what there is a decoder for here, which is not the same as what needs one", async () => {
    const { transcodableAudio } = await load();
    // Being on this list does not mean a track will be re-encoded — only that it could be, if
    // the browser turns out not to take it. Dolby is here because Chrome ships no decoder for it
    // and would otherwise lose the hardware path over most of a library.
    for (const codecId of ["A_DTS", "A_DTS/EXPRESS", "A_DTS/LOSSLESS", "A_AC3", "A_EAC3"]) {
      expect(transcodableAudio({ codecId } as never)).toBe(true);
    }
    // AAC every browser takes, and TrueHD has no decoder here at all.
    for (const codecId of ["A_AAC", "A_TRUEHD", "A_MPEG/L2"]) {
      expect(transcodableAudio({ codecId } as never)).toBe(false);
    }
  });
});

describe("canEncodeAac", () => {
  it("asks a second time without a bitrate before believing a refusal", async () => {
    const asked: { bitrate?: number }[] = [];
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async (c: { bitrate?: number }) => {
        asked.push(c);
        return { supported: c.bitrate === undefined };
      },
    });
    const { canEncodeAac } = await load();

    // A desktop Chrome says no to an imposed bitrate and yes with nothing specified; reading the
    // first answer as final sends a file down a slower path for no reason. The bitrate is asked
    // for first all the same: an encoder left to choose reaches for HE-AAC, whose description
    // does not match the profile written beside it.
    expect(await canEncodeAac(48000, 6)).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[0].bitrate).toBe(320_000);
    expect(asked[1].bitrate).toBeUndefined();
  });

  it("is false where there is no encoder at all", async () => {
    vi.stubGlobal("AudioEncoder", undefined);
    const { canEncodeAac } = await load();
    expect(await canEncodeAac(48000, 2)).toBe(false);
  });
});

describe("AudioTranscoder", () => {
  it("refuses plainly where the browser cannot encode", async () => {
    vi.stubGlobal("AudioEncoder", undefined);
    const { AudioTranscoder } = await load();
    await expect(AudioTranscoder.open(source as never, track as never)).rejects.toThrow(/encoder/);
  });

  it("takes its track description from the encoder, since the file has none to give", async () => {
    vi.stubGlobal("AudioEncoder", fakeEncoderClass());
    samples.mockImplementation(() => decoded(8));
    const { AudioTranscoder } = await load();

    const transcoder = await AudioTranscoder.open(source as never, track as never);
    // An MP4 needs a description that only exists once something has been encoded — so a little
    // sound is pushed through at open, and this is what comes back.
    expect(transcoder.sampleEntry.length).toBeGreaterThan(20);
    expect(new TextDecoder().decode(transcoder.sampleEntry.subarray(4, 8))).toBe("mp4a");
    expect(transcoder.codecString).toBe("mp4a.40.2");
    expect(transcoder.channels).toBe(6);
  });

  it("says so rather than producing a track nothing describes", async () => {
    // An encoder that never carries the description: silently muxing that would give the browser
    // an audio track it cannot configure a decoder for.
    vi.stubGlobal("AudioEncoder", fakeEncoderClass({ describeAfter: 999 }));
    samples.mockImplementation(() => decoded(8));
    const { AudioTranscoder } = await load();
    await expect(AudioTranscoder.open(source as never, track as never)).rejects.toThrow(/décrit/);
  });

  it("hands back the frames below a boundary and keeps the rest for the next segment", async () => {
    vi.stubGlobal("AudioEncoder", fakeEncoderClass());
    samples.mockImplementation(() => decoded(400));
    const { AudioTranscoder } = await load();
    const transcoder = await AudioTranscoder.open(source as never, track as never);

    const first = await transcoder.framesUpTo(1);
    const second = await transcoder.framesUpTo(2);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);

    // The two segments must tile: nothing repeated, nothing dropped between them.
    expect(Math.max(...first.map((f) => f.timestampUs))).toBeLessThan(1_000_000);
    expect(Math.min(...second.map((f) => f.timestampUs))).toBeGreaterThanOrEqual(1_000_000);
    const times = [...first, ...second].map((f) => f.timestampUs);
    expect(new Set(times).size).toBe(times.length);
  });

  it("restarts decoding where a seek asks, not where it had got to", async () => {
    vi.stubGlobal("AudioEncoder", fakeEncoderClass());
    samples.mockImplementation((from: number) => decoded(200, from));
    const { AudioTranscoder } = await load();
    const transcoder = await AudioTranscoder.open(source as never, track as never);
    await transcoder.framesUpTo(1);

    transcoder.seekTo(900);
    const frames = await transcoder.framesUpTo(901);
    expect(frames.length).toBeGreaterThan(0);
    expect(Math.min(...frames.map((f) => f.timestampUs))).toBeGreaterThanOrEqual(900_000_000);
  });
});
