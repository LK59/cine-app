import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Remuxer, audioDelivery, plannedMimeTypes, playableAudio, remuxableAudio } from "@/lib/webcodecs/remuxer";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

// A stand-in transcoder, so the one property that matters here can be checked: what is released,
// and when. The real one needs a decoder and an encoder that exist only in a browser.
const opened: { closed: boolean }[] = [];
let openFails = false;
let transcoderCodec = "mp4a.40.2";
vi.mock("@/lib/webcodecs/audioTranscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webcodecs/audioTranscode")>();
  return {
    ...original,
    AudioTranscoder: {
      open: async () => {
        if (openFails) throw new Error("l'encodeur a refusé");
        const instance = {
          closed: false,
          codecString: transcoderCodec,
          sampleEntry: new Uint8Array([0, 0, 0, 8, 0x6d, 0x70, 0x34, 0x61]),
          sampleRate: 48000,
          channels: 6,
          seekTo: () => {},
          framesUpTo: async () => [],
          close() {
            this.closed = true;
          },
        };
        opened.push(instance);
        return instance;
      },
    },
  };
});

const HVCC = new Uint8Array([1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0x78, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0]);
const AVCC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0xb0]);
const AAC_CONFIG = new Uint8Array([0x11, 0x90]);

function track(o: Partial<MatroskaTrack> & Pick<MatroskaTrack, "number" | "type" | "codecId">): MatroskaTrack {
  return {
    codecPrivate: null, language: "fra", name: null,
    isDefault: true, isForced: false, isEnabled: true, defaultDurationNs: null, ...o,
  };
}

const VIDEO = track({ number: 1, type: "video", codecId: "V_MPEGH/ISO/HEVC", codecPrivate: HVCC, video: { width: 1920, height: 1080 } });
const AUDIO_FR = track({ number: 2, type: "audio", codecId: "A_AAC", codecPrivate: AAC_CONFIG, audio: { sampleRate: 48000, channels: 2 } });
const AUDIO_EN = track({ ...AUDIO_FR, number: 3, language: "eng" });
const SRT_FR = track({ number: 4, type: "subtitle", codecId: "S_TEXT/UTF8" });
const ASS = track({ number: 5, type: "subtitle", codecId: "S_TEXT/ASS" });
const PGS = track({ number: 6, type: "subtitle", codecId: "S_HDMV/PGS" });

const FILE: MatroskaFile = {
  timestampScaleNs: 1_000_000, durationSeconds: 5400,
  tracks: [VIDEO, AUDIO_FR, AUDIO_EN, SRT_FR, ASS, PGS], cues: [],
  segmentDataStart: 0, segmentEnd: 1000, firstClusterOffset: 0,
};

const SOURCE: ByteSource = { size: 1000, read: async () => new Uint8Array(0), close: () => {} };

// What a track becomes is now asked of the browser, so these need one to ask. This stands in for
// a player that takes every codec in a container — the iPhone case, where nothing is re-encoded.
beforeEach(() => {
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: () => true } });
});
afterEach(() => vi.unstubAllGlobals());

const open = (audio: MatroskaTrack | null = AUDIO_FR) =>
  Remuxer.open(SOURCE, FILE, VIDEO, audio, { width: 1920, height: 1080 });

describe("Remuxer track selection", () => {
  it("offers only the subtitle tracks it can actually render as text", async () => {
    const remuxer = await open();
    const numbers = remuxer.subtitleTracks().map((t) => t.number);
    // Image subtitles carry no text to extract, so offering them would be a menu entry that
    // silently does nothing.
    expect(numbers).toContain(SRT_FR.number);
    expect(numbers).not.toContain(PGS.number);
  });

  it("offers the styled formats it can strip to text, alongside plain ones", async () => {
    const remuxer = await open();
    const numbers = remuxer.subtitleTracks().map((t) => t.number);
    // ASS carries positioning and fonts this cannot honour, but its dialogue lines are text and
    // showing them plainly beats showing nothing.
    expect(numbers).toContain(ASS.number);
  });

  it("lists every audio track, so the language menu is complete", async () => {
    const remuxer = await open();
    expect(remuxer.audioTracks().map((t) => t.language)).toEqual(["fra", "eng"]);
  });

  it("states the file's length and the codecs a browser will be asked about", async () => {
    const plan = (await open()).plan();
    expect(plan.durationSeconds).toBe(5400);
    expect(plan.videoMimeType).toMatch(/^video\/mp4; codecs="hvc1\./);
    expect(plan.audioMimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(plan.videoInit.length).toBeGreaterThan(100);
  });

  it("reports no delay before anything has been read", async () => {
    expect((await open()).diagnostics()).toEqual({
      presentationDelaySeconds: 0,
      clampedSamples: 0,
      transcodedAudio: false,
    });
  });

  it("refuses a codec it can neither repackage nor re-encode", async () => {
    // TrueHD has no decoder here at all, so there is nothing to turn it into.
    const trueHd = track({ number: 2, type: "audio", codecId: "A_TRUEHD", audio: { sampleRate: 48000, channels: 6 } });
    await expect(Remuxer.open(SOURCE, FILE, VIDEO, trueHd, { width: 1920, height: 1080 })).rejects.toThrow(/A_TRUEHD/);

    const vp9 = track({ number: 1, type: "video", codecId: "V_VP9" });
    await expect(Remuxer.open(SOURCE, FILE, vp9, null, { width: 1920, height: 1080 })).rejects.toThrow(/V_VP9/);
  });

  it("counts a track that has to be re-encoded as playable, and says what will arrive", () => {
    const dts = track({ number: 2, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    // Even a player that takes everything else has no DTS, so what reaches it is what comes out
    // of the encoder — and that is what the MIME type has to describe.
    expect(playableAudio(dts)).toBe(true);
    expect(remuxableAudio(dts)).toBe(false);
    expect(plannedMimeTypes(VIDEO, dts).audio).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("carries a codec the player takes, and re-encodes the same codec where it does not", () => {
    const eac3 = track({ number: 2, type: "audio", codecId: "A_EAC3", audio: { sampleRate: 48000, channels: 6 } });
    expect(audioDelivery(eac3)).toBe("copy");
    expect(plannedMimeTypes(VIDEO, eac3).audio).toBe('audio/mp4; codecs="ec-3"');

    // The same track on a player with no Dolby decoder — Chrome, which would otherwise lose the
    // hardware path over most of a library.
    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => t.includes("mp4a") } });
    expect(audioDelivery(eac3)).toBe("transcode");
    expect(plannedMimeTypes(VIDEO, eac3).audio).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("refuses a re-encoded track this browser will not take back", async () => {
    // Safari, asked for AAC-LC, may answer with HE-AAC. Writing the profile that was asked for
    // over the description that came out produces an init segment that contradicts itself — and
    // Safari answers that by closing the MediaSource, taking the video buffer with it. Better to
    // find out here, where the old track is still playing.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    FILE.tracks.push(dts);
    opened.length = 0;
    transcoderCodec = "mp4a.40.5";
    vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => !t.includes("mp4a.40.5") } });

    try {
      await expect(Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 })).rejects.toThrow(
        /n'accepte pas lui-même/
      );
      // And nothing is left running behind the refusal.
      expect(opened[0].closed).toBe(true);
    } finally {
      FILE.tracks.pop();
      transcoderCodec = "mp4a.40.2";
    }
  });

  it("names what the encoder produced, not what it was asked for", async () => {
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    FILE.tracks.push(dts);
    transcoderCodec = "mp4a.40.5";
    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      expect(remuxer.plan().audioMimeType).toBe('audio/mp4; codecs="mp4a.40.5"');
    } finally {
      FILE.tracks.pop();
      transcoderCodec = "mp4a.40.2";
    }
  });

  it("keeps the track it has, and the machinery for it, when a change fails", async () => {
    // Start on a track that is being re-encoded, so there is something to lose.
    const dts = track({ number: 7, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    const otherDts = track({ ...dts, number: 8, language: "eng" });
    FILE.tracks.push(dts, otherDts);
    opened.length = 0;
    openFails = false;

    try {
      const remuxer = await Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 });
      expect(opened).toHaveLength(1);
      const before = remuxer.plan().audioMimeType;

      // Releasing the working one first and then failing to open its replacement leaves nothing
      // able to produce sound: no segments, a buffer that never advances, and a player loading
      // for ever with nothing to say for itself.
      openFails = true;
      await expect(remuxer.setAudioTrack(otherDts.number)).rejects.toThrow();
      expect(opened[0].closed).toBe(false);
      expect(remuxer.plan().audioMimeType).toBe(before);
    } finally {
      FILE.tracks.splice(-2, 2);
      openFails = false;
    }
  });

  it("says an AC-3 track cannot be described when the file yields no frame to read", async () => {
    // The description lives in the bitstream, so an empty read is a real failure rather than a
    // reason to guess at the channel layout.
    const ac3 = track({ number: 2, type: "audio", codecId: "A_AC3", audio: { sampleRate: 48000, channels: 6 } });
    await expect(Remuxer.open(SOURCE, FILE, VIDEO, ac3, { width: 1920, height: 1080 })).rejects.toThrow(/AC-3/);
  });
});

describe("plannedMimeTypes", () => {
  it("derives both codec strings from the headers alone, with no reading", () => {
    expect(plannedMimeTypes(VIDEO, AUDIO_FR)).toEqual({
      video: expect.stringMatching(/^video\/mp4; codecs="hvc1\./),
      audio: 'audio/mp4; codecs="mp4a.40.2"',
    });
    const avc = track({ number: 1, type: "video", codecId: "V_MPEG4/ISO/AVC", codecPrivate: AVCC });
    expect(plannedMimeTypes(avc, null)).toEqual({ video: 'video/mp4; codecs="avc1.640028"', audio: null });
  });

  it("returns nothing for a codec it cannot describe, rather than an invalid string", () => {
    expect(plannedMimeTypes(track({ number: 1, type: "video", codecId: "V_VP9" }), null).video).toBeNull();
    expect(plannedMimeTypes(VIDEO, track({ number: 2, type: "audio", codecId: "A_TRUEHD" })).audio).toBeNull();
  });
});
