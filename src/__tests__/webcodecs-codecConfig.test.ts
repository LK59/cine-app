import { describe, it, expect } from "vitest";
import {
  hevcCodecString,
  avcCodecString,
  av1CodecString,
  videoConfigFor,
  audioConfigFor,
  unsupportedReason,
} from "@/lib/webcodecs/codecConfig";
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
