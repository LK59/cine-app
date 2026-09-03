import { describe, it, expect } from "vitest";
import { isRandomAccessPoint, nalLengthSize,
  hevcCodecString,
  avcCodecString,
  av1CodecString,
  videoConfigFor,
  audioConfigFor,
  unsupportedReason,
} from "@/lib/webcodecs/codecConfig";
import { selectCue, subtitleText } from "@/lib/webcodecs/engine";
import type { MatroskaTrack } from "@/lib/webcodecs/matroska";

// A codec string is matched character for character against the browser's hardware capabilities.
// It doesn't degrade when wrong — the decoder refuses the configuration, or accepts it and
// produces garbage — so these are pinned against values read out of real library files.
function hvcC({ profileSpace = 0, tier = 0, profileIdc = 2, compatibility = 0x20000000, constraint = [0x90, 0, 0, 0, 0, 0], level = 150 }) {
  return new Uint8Array([
    1,
    (profileSpace << 6) | (tier << 5) | profileIdc,
    (compatibility >>> 24) & 0xff,
    (compatibility >>> 16) & 0xff,
    (compatibility >>> 8) & 0xff,
    compatibility & 0xff,
    ...constraint,
    level,
  ]);
}

function track(partial: Partial<MatroskaTrack>): MatroskaTrack {
  return {
    number: 1,
    type: "video",
    codecId: "",
    codecPrivate: null,
    language: null,
    name: null,
    isDefault: true,
    isForced: false,
    isEnabled: true,
    defaultDurationNs: null,
    ...partial,
  };
}

describe("HEVC codec strings", () => {
  // Both taken from real files in the library: a 4K Main 10 and a 1080p Main.
  it("builds the string a browser actually matches on", () => {
    expect(hevcCodecString(hvcC({}))).toBe("hvc1.2.4.L150.90");
    expect(hevcCodecString(hvcC({ profileIdc: 1, compatibility: 0x60000000, level: 120 }))).toBe("hvc1.1.6.L120.90");
  });

  it("marks the high tier and the profile space", () => {
    expect(hevcCodecString(hvcC({ tier: 1 }))).toContain(".H150.");
    expect(hevcCodecString(hvcC({ profileSpace: 1 }))).toMatch(/^hvc1\.A2\./);
  });

  it("drops trailing zero constraint bytes, which no browser expects to see", () => {
    expect(hevcCodecString(hvcC({ constraint: [0x90, 0x80, 0, 0, 0, 0] }))).toBe("hvc1.2.4.L150.90.80");
    expect(hevcCodecString(hvcC({ constraint: [0, 0, 0, 0, 0, 0] }))).toBe("hvc1.2.4.L150");
  });

  it("refuses a record too short to describe a profile instead of inventing one", () => {
    expect(hevcCodecString(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("other codec strings", () => {
  it("builds avc1 from profile, compatibility and level", () => {
    expect(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x28]))).toBe("avc1.640028");
    expect(avcCodecString(new Uint8Array([1, 0x42, 0xc0, 0x1e]))).toBe("avc1.42c01e");
  });

  it("builds av01 from the sequence profile, level and tier", () => {
    expect(av1CodecString(new Uint8Array([0x81, 0x00 | 8, 0x00]))).toBe("av01.0.08M.08");
  });
});

describe("track configuration", () => {
  it("configures an HEVC track with its codec-private description", () => {
    const priv = hvcC({});
    const config = videoConfigFor(track({ codecId: "V_MPEGH/ISO/HEVC", codecPrivate: priv, video: { width: 3840, height: 1680 } }));
    expect(config).toMatchObject({ codec: "hvc1.2.4.L150.90", codedWidth: 3840, codedHeight: 1680 });
    expect(config?.description).toBe(priv);
  });

  it("refuses an HEVC track with no configuration record rather than guessing a profile", () => {
    const t = track({ codecId: "V_MPEGH/ISO/HEVC", codecPrivate: null, video: { width: 1920, height: 1080 } });
    expect(videoConfigFor(t)).toBeNull();
    expect(unsupportedReason(t)).toContain("configuration de décodeur");
  });

  it("configures AAC only with its AudioSpecificConfig, which carries the profile and SBR rate", () => {
    const base = { type: "audio" as const, audio: { sampleRate: 48000, channels: 6 } };
    expect(audioConfigFor(track({ ...base, codecId: "A_AAC", codecPrivate: new Uint8Array([0x11, 0x90]) }))).toMatchObject({
      codec: "mp4a.40.2",
      sampleRate: 48000,
      numberOfChannels: 6,
    });
    expect(audioConfigFor(track({ ...base, codecId: "A_AAC", codecPrivate: null }))).toBeNull();
  });

  // AC3 and E-AC3 are 71% of this library's default audio tracks. They are not part of the web
  // platform's baseline, but Apple devices and Windows decode them at the OS level and WebCodecs
  // exposes whatever the platform has — so they are configured and offered up for
  // AudioDecoder.isConfigSupported() to accept or refuse, rather than written off in advance.
  it("offers AC3 and E-AC3 to the platform instead of assuming they are impossible", () => {
    const base = { type: "audio" as const, audio: { sampleRate: 48000, channels: 6 } };
    expect(audioConfigFor(track({ ...base, codecId: "A_AC3" }))?.codec).toBe("ac-3");
    expect(audioConfigFor(track({ ...base, codecId: "A_EAC3" }))?.codec).toBe("ec-3");
  });

  // DTS and TrueHD have no decoder on any platform and no registered codec string, so asking
  // would be theatre.
  it("refuses DTS and TrueHD up front, naming what is missing", () => {
    for (const codecId of ["A_DTS", "A_TRUEHD", "A_MLP"]) {
      const t = track({ type: "audio", codecId, audio: { sampleRate: 48000, channels: 6 } });
      expect(audioConfigFor(t)).toBeNull();
      expect(unsupportedReason(t)).toContain("décodeur logiciel");
    }
  });

  it("passes Opus, FLAC and MP3 straight through", () => {
    const base = { type: "audio" as const, audio: { sampleRate: 48000, channels: 2 } };
    expect(audioConfigFor(track({ ...base, codecId: "A_OPUS" }))?.codec).toBe("opus");
    expect(audioConfigFor(track({ ...base, codecId: "A_FLAC" }))?.codec).toBe("flac");
    expect(audioConfigFor(track({ ...base, codecId: "A_MPEG/L3" }))?.codec).toBe("mp3");
  });
});

describe("subtitle cue selection", () => {
  const cues = () => [
    { startSeconds: 1, endSeconds: 3, text: "un" },
    { startSeconds: 3.5, endSeconds: 5, text: "deux" },
    { startSeconds: 10, endSeconds: 12, text: "trois" },
  ];

  it("shows the line whose window contains the playhead", () => {
    expect(selectCue(cues(), 2)?.text).toBe("un");
    expect(selectCue(cues(), 4)?.text).toBe("deux");
    expect(selectCue(cues(), 11)?.text).toBe("trois");
  });

  it("shows nothing in the gaps, including before the first line", () => {
    expect(selectCue(cues(), 0.5)).toBeNull();
    expect(selectCue(cues(), 3.2)).toBeNull();
    expect(selectCue(cues(), 99)).toBeNull();
  });

  it("includes both edges of a line's window", () => {
    expect(selectCue(cues(), 1)?.text).toBe("un");
    expect(selectCue(cues(), 3)?.text).toBe("un");
  });

  // Cues arrive in order and are consumed in order; dropping the past ones is what stops this
  // re-scanning a growing list on every animation frame.
  it("discards expired lines as it goes", () => {
    const queue = cues();
    selectCue(queue, 11);
    expect(queue).toHaveLength(1);
    expect(queue[0].text).toBe("trois");
  });
});

describe("subtitle text extraction", () => {
  it("passes SRT through untouched", () => {
    expect(subtitleText("Bonjour\nle monde", "S_TEXT/UTF8")).toBe("Bonjour\nle monde");
  });

  // An ASS block is the tail of a Dialogue row: nine fields, then the text. Throwing the track
  // away over its styling would leave 218 files in this library with no subtitles at all when
  // the words are right there.
  it("takes the text out of an ASS dialogue row", () => {
    expect(subtitleText("0,0,Default,,0,0,0,,Bonjour le monde", "S_TEXT/ASS")).toBe("Bonjour le monde");
  });

  it("keeps commas that belong to the line", () => {
    expect(subtitleText("0,0,Default,,0,0,0,,Bonjour, le monde", "S_TEXT/ASS")).toBe("Bonjour, le monde");
  });

  it("strips inline override tags and honours ASS line breaks", () => {
    expect(subtitleText("0,0,Default,,0,0,0,,{\\i1}Salut{\\i0}\\Nla suite", "S_TEXT/ASS")).toBe("Salut\nla suite");
  });
});

describe("isRandomAccessPoint", () => {
  /** Length-prefixed NAL units, as a sample carries them. */
  const sample = (...nals: number[][]) => {
    const out: number[] = [];
    for (const nal of nals) {
      out.push(0, 0, 0, nal.length, ...nal);
    }
    return new Uint8Array(out);
  };
  const hevcNal = (type: number, ...rest: number[]) => [(type << 1) & 0xfe, 1, ...rest];

  it("reads past a prefix SEI to find the picture itself", () => {
    // Real samples open with a prefix SEI more often than not, and taking the first NAL unit for
    // the picture reads type 39 and answers nonsense.
    const withSei = sample(hevcNal(39, 0, 0), hevcNal(21, 0, 0));
    expect(isRandomAccessPoint(withSei, "V_MPEGH/ISO/HEVC", 4)).toBe(true);
  });

  it("refuses a trailing picture the container calls a keyframe", () => {
    // Measured on a real file: 4 of every 21 blocks it marks as keyframes are TRAIL_R, and a
    // segment opening on one of them closed the MediaSource on Safari every single time.
    expect(isRandomAccessPoint(sample(hevcNal(1, 0, 0)), "V_MPEGH/ISO/HEVC", 4)).toBe(false);
    expect(isRandomAccessPoint(sample(hevcNal(0, 0, 0)), "V_MPEGH/ISO/HEVC", 4)).toBe(false);
  });

  it("accepts every flavour of intra random access point", () => {
    for (const type of [16, 19, 20, 21, 23]) {
      expect(isRandomAccessPoint(sample(hevcNal(type, 0, 0)), "V_MPEGH/ISO/HEVC", 4)).toBe(true);
    }
  });

  it("tells an AVC IDR slice from an ordinary one", () => {
    expect(isRandomAccessPoint(sample([0x65, 0, 0]), "V_MPEG4/ISO/AVC", 4)).toBe(true);
    expect(isRandomAccessPoint(sample([0x41, 0, 0]), "V_MPEG4/ISO/AVC", 4)).toBe(false);
  });

  it("takes the container's word where it cannot read the picture", () => {
    // A codec with no NAL units, and bytes that are not a length-prefixed stream at all.
    expect(isRandomAccessPoint(sample([1, 2, 3]), "V_VP9", 4)).toBe(true);
    expect(isRandomAccessPoint(new Uint8Array([0xff, 0xff]), "V_MPEGH/ISO/HEVC", 4)).toBe(true);
  });

  it("reads the length prefix size from the codec's own configuration", () => {
    // hvcC: the field is the low two bits of byte 21, plus one.
    const hvcC = new Uint8Array(23);
    hvcC[21] = 0x01;
    expect(nalLengthSize("V_MPEGH/ISO/HEVC", hvcC)).toBe(2);
    hvcC[21] = 0x03;
    expect(nalLengthSize("V_MPEGH/ISO/HEVC", hvcC)).toBe(4);
    // Nothing to read from: four, which is what every file in practice uses.
    expect(nalLengthSize("V_MPEGH/ISO/HEVC", null)).toBe(4);
  });
});
