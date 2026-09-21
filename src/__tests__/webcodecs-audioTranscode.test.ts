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
function fakeEncoderClass(options: { describeAfter?: number; failWith?: string; refuseAbove?: number } = {}) {
  return class {
    static supportedCalls: unknown[] = [];
    /** Every configuration handed to configure(), across every instance. */
    static configured: { bitrate?: number }[] = [];
    static instances = 0;
    static resets = 0;
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
      (this.constructor as unknown as { instances: number }).instances++;
      if (options.failWith) queueMicrotask(() => init.error({ message: options.failWith } as never));
    }
    configure(config: { bitrate?: number }) {
      (this.constructor as unknown as { configured: unknown[] }).configured.push(config);
      // An encoder that said yes to isConfigSupported and fails in use — the case the ladder is
      // tried against for real.
      if (options.refuseAbove !== undefined && (config.bitrate ?? 0) > options.refuseAbove) {
        throw new Error(`bitrate ${config.bitrate} not supported`);
      }
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
      (this.constructor as unknown as { resets: number }).resets++;
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
    // FLAC since 21/09/2026: Safari refuses it in a MediaSource, where Chrome and Firefox take it.
    // TrueHD and MLP since 21/09/2026: FFmpeg's decoder, compiled to WebAssembly.
    for (const codecId of ["A_DTS", "A_DTS/EXPRESS", "A_DTS/LOSSLESS", "A_AC3", "A_EAC3", "A_FLAC", "A_TRUEHD", "A_MLP"]) {
      expect(transcodableAudio({ codecId } as never)).toBe(true);
    }
    // AAC every browser takes, and RealAudio has no decoder here at all.
    for (const codecId of ["A_AAC", "A_REAL/COOK", "A_MPEG/L2"]) {
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
    // The ladder, best first, then nothing imposed: 96, 64 and 40 kbit/s per channel on a 5.1.
    expect(asked.map((c) => c.bitrate)).toEqual([576_000, 384_000, 240_000, undefined]);
  });

  it("asks for enough bits per channel, and keeps the first rate the encoder accepts", async () => {
    // Until 22/09/2026, a single 320 kbit/s whatever the layout: 40 per channel on a 7.1, a second
    // lossy generation a good pair of headphones could tell from its source.
    const asked: { bitrate?: number; numberOfChannels: number }[] = [];
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async (c: { bitrate?: number; numberOfChannels: number }) => {
        asked.push(c);
        return { supported: (c.bitrate ?? 0) <= 512_000 };
      },
    });
    const { canEncodeAac } = await load();
    expect(await canEncodeAac(48000, 8)).toBe(true);
    expect(asked.map((c) => c.bitrate)).toEqual([768_000, 512_000]);

    // Stereo never drops below 128 kbit/s, and the ladder never asks the same rate twice.
    const aac: { bitrate?: number; codec: string }[] = [];
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async (c: { bitrate?: number; codec: string }) => (c.codec === "mp4a.40.2" && aac.push(c), { supported: false }),
    });
    expect(await canEncodeAac(48000, 1)).toBe(false);
    expect(aac.map((c) => c.bitrate)).toEqual([128_000, undefined, undefined]);
  });

  it("is false where there is no encoder at all", async () => {
    vi.stubGlobal("AudioEncoder", undefined);
    const { canEncodeAac } = await load();
    expect(await canEncodeAac(48000, 2)).toBe(false);
  });
});

describe("chooseTranscodePlan chez Apple", () => {
  it("ne demande jamais plus de six canaux à l'encodeur AAC d'Apple : un 7.1 y est replié en 5.1", async () => {
    // L'AAC n'a pas de vrai 7.1 à enceintes arrière, et l'encodeur d'Apple ne dit pas où il range
    // huit plans. Braveheart en VO 7.1 sur iPhone, 21/09/2026 : les voix plus fortes à droite.
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    });
    vi.stubGlobal("AudioEncoder", { isConfigSupported: async () => ({ supported: true }) });
    const { chooseTranscodePlan } = await load();
    expect(await chooseTranscodePlan(48000, 8)).toEqual({ codec: "mp4a.40.2", channels: 6 });
    expect(await chooseTranscodePlan(48000, 6)).toEqual({ codec: "mp4a.40.2", channels: 6 });

    // Ailleurs, le 7.1 reste un 7.1 si l'encodeur le prend.
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" });
    expect(await chooseTranscodePlan(48000, 8)).toEqual({ codec: "mp4a.40.2", channels: 8 });
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

  it("keeps the exact configuration that described the track, bitrate included, across seeks", async () => {
    // Until 22/09/2026 a seek reconfigured the encoder without a bitrate — and opening ends with
    // one. The rate asked for served only the priming; the whole film ran at the browser's default,
    // from an encoder configured unlike the one whose description the container carries.
    const Encoder = fakeEncoderClass();
    vi.stubGlobal("AudioEncoder", Encoder);
    samples.mockImplementation(() => decoded(400));
    const { AudioTranscoder } = await load();
    const transcoder = await AudioTranscoder.open(source as never, track as never);
    transcoder.seekTo(120);
    transcoder.seekTo(3600);
    expect(Encoder.configured.length).toBeGreaterThanOrEqual(3);
    expect(new Set(Encoder.configured.map((c) => c.bitrate))).toEqual(new Set([576_000]));
  });

  it("starts a fresh encoder at every seek rather than resetting the one it has", async () => {
    // 21/09/2026, iPhone: every fresh encoder primed; every "InternalAudioEncoderCocoa encoding
    // failed" followed a reset() and a configure() — the note in remuxer.ts had said "always
    // after a change of track, never at the start" for weeks. A fresh one is the path that held.
    const Encoder = fakeEncoderClass();
    vi.stubGlobal("AudioEncoder", Encoder);
    samples.mockImplementation(() => decoded(400));
    const { AudioTranscoder } = await load();
    const transcoder = await AudioTranscoder.open(source as never, track as never);
    const before = Encoder.instances;
    transcoder.seekTo(120);
    transcoder.seekTo(3600);
    expect(Encoder.resets).toBe(0);
    expect(Encoder.instances).toBe(before + 2);
    expect((await transcoder.framesUpTo(3601)).length).toBeGreaterThan(0);
  });

  it("starts lower after an encoder failed in use at the rate it was given", async () => {
    // The same evening: 768 kbit/s in 7.1 accepted, primed, then failing on the way — and every
    // rebuild asked for 768 again until the film went to the server player.
    const { AudioTranscoder, forgetBitrateCeilings } = await load();
    forgetBitrateCeilings();
    const Encoder = fakeEncoderClass();
    vi.stubGlobal("AudioEncoder", Encoder);
    samples.mockImplementation(() => decoded(400));
    const first = await AudioTranscoder.open(source as never, track as never);
    (first as unknown as { fail(message: string): void }).fail("InternalAudioEncoderCocoa encoding failed");
    await expect(first.framesUpTo(1)).rejects.toThrow(/Cocoa/);

    Encoder.configured.length = 0;
    await AudioTranscoder.open(source as never, track as never);
    expect(Encoder.configured[0].bitrate).toBe(384_000);
    forgetBitrateCeilings();
  });

  it("never goes below the last rate of the ladder, however many failures", async () => {
    // Without a rate, Safari answers with HE-AAC — another object type than the one already
    // described to the buffer. Three failures used to empty the ladder and get exactly that.
    const { AudioTranscoder, forgetBitrateCeilings } = await load();
    forgetBitrateCeilings();
    const Encoder = fakeEncoderClass();
    vi.stubGlobal("AudioEncoder", Encoder);
    samples.mockImplementation(() => decoded(400));
    for (let i = 0; i < 4; i++) {
      const t = await AudioTranscoder.open(source as never, track as never);
      (t as unknown as { fail(message: string): void }).fail("InternalAudioEncoderCocoa encoding failed");
    }
    Encoder.configured.length = 0;
    await AudioTranscoder.open(source as never, track as never);
    expect(Encoder.configured[0].bitrate).toBe(240_000);
    forgetBitrateCeilings();
  });

  it("does not listen to an encoder it has replaced", async () => {
    // After a seek the old encoder is closed, but a frame or an error already queued on it can
    // still arrive. A late frame was mixed with the new ones; a late error rebuilt a healthy
    // encoder and lowered the rate for the whole page.
    const { AudioTranscoder, forgetBitrateCeilings } = await load();
    forgetBitrateCeilings();
    const made: { init: { output: (c: unknown) => void; error: (e: unknown) => void } }[] = [];
    const Base = fakeEncoderClass();
    vi.stubGlobal(
      "AudioEncoder",
      class extends Base {
        constructor(init: { output: (c: unknown) => void; error: (e: unknown) => void }) {
          super(init as never);
          made.push({ init });
        }
      }
    );
    samples.mockImplementation(() => decoded(400));
    const transcoder = await AudioTranscoder.open(source as never, track as never);
    const old = made[made.length - 1];
    transcoder.seekTo(10);
    old.init.error({ message: "InternalAudioEncoderCocoa encoding failed" });
    old.init.output({ timestamp: 99_000_000, duration: 21_333, byteLength: 8, copyTo: (d: Uint8Array) => d.fill(1) });
    const frames = await transcoder.framesUpTo(11);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.timestampUs < 99_000_000)).toBe(true);
    forgetBitrateCeilings();
  });

  it("goes down the ladder when a rate fails in use, and keeps the one that worked", async () => {
    const Encoder = fakeEncoderClass({ refuseAbove: 400_000 });
    vi.stubGlobal("AudioEncoder", Encoder);
    samples.mockImplementation(() => decoded(400));
    const { AudioTranscoder } = await load();
    const transcoder = await AudioTranscoder.open(source as never, track as never);
    expect(transcoder.sampleEntry.length).toBeGreaterThan(20);
    // 576 refused at configure, 384 accepted — and every later configure is 384.
    expect(Encoder.configured[0].bitrate).toBe(576_000);
    expect(new Set(Encoder.configured.slice(1).map((c) => c.bitrate))).toEqual(new Set([384_000]));
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
