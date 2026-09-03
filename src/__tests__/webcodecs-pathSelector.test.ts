import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { choosePlaybackPath, describePath, type PathInput } from "@/lib/webcodecs/pathSelector";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
import { plannedMimeTypes } from "@/lib/webcodecs/remuxer";

// A real hvcC: Main profile, level 120. The selector reads it to build the codec string it then
// asks the browser about, so a placeholder would not exercise the decision at all.
const HVCC = new Uint8Array([
  1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0x78, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0,
]);
const AAC_CONFIG = new Uint8Array([0x11, 0x90]); // AAC-LC, 48 kHz, stereo

function track(overrides: Partial<MatroskaTrack> & Pick<MatroskaTrack, "number" | "type" | "codecId">): MatroskaTrack {
  return {
    codecPrivate: null, language: "fra", name: null,
    isDefault: true, isForced: false, isEnabled: true, defaultDurationNs: null,
    ...overrides,
  };
}

const VIDEO = track({ number: 1, type: "video", codecId: "V_MPEGH/ISO/HEVC", codecPrivate: HVCC, video: { width: 1920, height: 1080 } });
const AAC = track({ number: 2, type: "audio", codecId: "A_AAC", codecPrivate: AAC_CONFIG, audio: { sampleRate: 48000, channels: 2 } });
const EAC3 = track({ number: 2, type: "audio", codecId: "A_EAC3", audio: { sampleRate: 48000, channels: 6 } });

function input(video = VIDEO, audio: MatroskaTrack | null = AAC): PathInput {
  const file: MatroskaFile = {
    timestampScaleNs: 1_000_000, durationSeconds: 3600,
    tracks: [video, ...(audio ? [audio] : [])], cues: [],
    segmentDataStart: 0, segmentEnd: 1000, firstClusterOffset: 0,
  };
  const source: ByteSource = { size: 1000, read: async () => new Uint8Array(0), close: () => {} };
  return { source, file, videoTrack: video, audioTrack: audio, dimensions: { width: 1920, height: 1080 } };
}

/** Derived, not hand-written: this suite is about the decision, not about codec-string syntax. */
function mimeFor(video: MatroskaTrack, audio: MatroskaTrack | null) {
  const mime = plannedMimeTypes(video, audio);
  return { video: mime.video!, audio: mime.audio };
}

// The transcoder itself needs a decoder and an encoder that only exist in a browser. What is
// being checked here is the decision — whether a track the player will not take is re-encoded
// rather than costing the hardware path — so the machinery behind it is stood in for.
vi.mock("@/lib/webcodecs/audioTranscode", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/webcodecs/audioTranscode")>();
  return {
    ...original,
    AudioTranscoder: {
      open: async () => ({
        sampleEntry: new Uint8Array([0, 0, 0, 8, 0x6d, 0x70, 0x34, 0x61]),
        codecString: "mp4a.40.2",
        sampleRate: 48000,
        channels: 6,
        seekTo: () => {},
        framesUpTo: async () => [],
        close: () => {},
      }),
    },
  };
});

let supported = new Set<string>();
beforeEach(() => {
  supported = new Set();
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => supported.has(t) } });
});
afterEach(() => vi.unstubAllGlobals());

describe("choosePlaybackPath", () => {
  it("prefers remuxing when the browser accepts both codecs", async () => {
    const mime = mimeFor(VIDEO, AAC);
    supported = new Set([mime.video, mime.audio!]);
    const chosen = await choosePlaybackPath(input());

    // The native path decodes in hardware and shows HDR without a shader; it is preferred
    // whenever it is available at all, not only when the other one fails.
    expect(chosen.path).toBe("remux");
    expect(chosen.remuxer).not.toBeNull();
    expect(chosen.plan?.videoMimeType).toBe(mime.video);
    expect(chosen.attempts).toEqual([{ path: "remux", ok: true }]);
  });

  it("re-encodes audio the browser will not take, rather than giving up the hardware path", async () => {
    // Chrome ships no Dolby decoder, so it takes neither AC-3 nor E-AC-3 in a container — and
    // that is most of this library. Losing hardware video over the sound would be the wrong
    // trade when the sound can simply be handed over as something else.
    supported = new Set([mimeFor(VIDEO, null).video, 'audio/mp4; codecs="mp4a.40.2"']);
    vi.stubGlobal("AudioEncoder", { isConfigSupported: async () => ({ supported: true }) });

    const chosen = await choosePlaybackPath(input(VIDEO, EAC3));
    expect(chosen.path).toBe("remux");
    expect(chosen.plan?.audioMimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
  });

  it("steps down to WebCodecs when it can neither carry nor re-encode the audio", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    vi.stubGlobal("AudioEncoder", undefined);
    const chosen = await choosePlaybackPath(input(VIDEO, EAC3));

    expect(chosen.path).toBe("webcodecs");
    expect(chosen.remuxer).toBeNull();
    expect(chosen.attempts[0]).toMatchObject({ path: "remux", ok: false });
    expect(chosen.attempts[0].reason).toContain("A_EAC3");
    expect(chosen.attempts[1]).toEqual({ path: "webcodecs", ok: true });
  });

  it("steps down when the container holds a codec the remuxer cannot describe", async () => {
    const supportedMime = mimeFor(VIDEO, AAC);
    supported = new Set([supportedMime.video, supportedMime.audio!]);
    const dts = track({ number: 2, type: "audio", codecId: "A_DTS", audio: { sampleRate: 48000, channels: 6 } });
    const chosen = await choosePlaybackPath(input(VIDEO, dts));

    expect(chosen.path).toBe("webcodecs");
    expect(chosen.attempts[0].reason).toContain("A_DTS");
  });

  it("steps down when the browser accepts nothing at all", async () => {
    vi.stubGlobal("AudioEncoder", undefined);
    const chosen = await choosePlaybackPath(input());
    expect(chosen.path).toBe("webcodecs");
    expect(chosen.attempts[0]).toMatchObject({ path: "remux", ok: false });
    expect(chosen.attempts[1]).toEqual({ path: "webcodecs", ok: true });
  });

  it("refuses out loud when neither path can carry the file, naming both reasons", async () => {
    // MPEG-2 is in no browser's WebCodecs and cannot be described in an MP4 sample entry here.
    const mpeg2 = track({ number: 1, type: "video", codecId: "V_MPEG2", video: { width: 720, height: 576 } });
    await expect(choosePlaybackPath(input(mpeg2, AAC))).rejects.toThrow(/V_MPEG2/);
    // Both refusals appear, so the panel can show the whole chain rather than only the last step.
    await expect(choosePlaybackPath(input(mpeg2, AAC))).rejects.toThrow(/remux[\s\S]*webcodecs/);
  });

  it("treats a file with no audio track as remuxable", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    const chosen = await choosePlaybackPath(input(VIDEO, null));
    expect(chosen.path).toBe("remux");
    expect(chosen.plan?.audioMimeType).toBeNull();
  });
});

describe("describePath", () => {
  it("names the path taken, and every one refused before it", async () => {
    supported = new Set([mimeFor(VIDEO, null).video]);
    expect(describePath(await choosePlaybackPath(input(VIDEO, null)))).toBe("remultiplexage → lecteur natif");

    vi.stubGlobal("AudioEncoder", undefined);
    const stepped = await choosePlaybackPath(input(VIDEO, EAC3));
    const described = describePath(stepped);
    expect(described).toContain("WebCodecs → canvas");
    expect(described).toContain("remux refusé");
    expect(described).toContain("A_EAC3");
  });
});
