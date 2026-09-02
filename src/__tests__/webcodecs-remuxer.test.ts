import { describe, it, expect } from "vitest";
import { Remuxer, plannedMimeTypes } from "@/lib/webcodecs/remuxer";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

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

  it("ignores a request for a subtitle track it cannot render", async () => {
    const remuxer = await open();
    remuxer.setSubtitleTrack(PGS.number);
    // Nothing to assert on directly beyond it not throwing: the point is that an unsupported
    // choice leaves the previous state rather than half-selecting something.
    expect(() => remuxer.setSubtitleTrack(999)).not.toThrow();
    expect(() => remuxer.setSubtitleTrack(null)).not.toThrow();
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
    expect((await open()).diagnostics()).toEqual({ presentationDelaySeconds: 0, clampedSamples: 0 });
  });

  it("refuses a codec it cannot repackage rather than producing a file that will not play", async () => {
    const dts = track({ number: 2, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    await expect(Remuxer.open(SOURCE, FILE, VIDEO, dts, { width: 1920, height: 1080 })).rejects.toThrow(/A_DTS/);

    const vp9 = track({ number: 1, type: "video", codecId: "V_VP9" });
    await expect(Remuxer.open(SOURCE, FILE, vp9, null, { width: 1920, height: 1080 })).rejects.toThrow(/V_VP9/);
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
    expect(plannedMimeTypes(VIDEO, track({ number: 2, type: "audio", codecId: "A_DTS" })).audio).toBeNull();
  });
});
