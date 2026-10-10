import { describe, it, expect } from "vitest";
import { audioNeedsReencode, buildDeviceProfile, chosenAudioStream } from "@/lib/deviceProfile";
import type { CodecSupport } from "@/lib/codecSupport";

const NO_SUPPORT: CodecSupport = { video: {}, audio: {} };

describe("buildDeviceProfile", () => {
  it("declares no DirectPlayProfiles when the browser can't decode any of the tested codecs", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 8_000_000);
    expect(profile.DirectPlayProfiles).toEqual([]);
  });

  it("only ever declares mp4/m4v as the DirectPlay container, never mkv — no target browser natively demuxes raw Matroska", () => {
    const support: CodecSupport = { video: { "mp4/h264": true }, audio: { aac: true } };
    const profile = buildDeviceProfile(support, 8_000_000);
    expect(profile.DirectPlayProfiles[0].Container).toBe("mp4,m4v");
  });

  it("lists every supported video codec and audio codec, joined by comma", () => {
    const support: CodecSupport = {
      video: { "mp4/h264": true, "mp4/hevc": true, "mp4/vp9": false },
      audio: { aac: true, ac3: true, dts: false },
    };
    const profile = buildDeviceProfile(support, 8_000_000);
    expect(profile.DirectPlayProfiles[0].VideoCodec).toBe("h264,hevc");
    expect(profile.DirectPlayProfiles[0].AudioCodec).toBe("aac,ac3");
  });

  it("requires both a supported video codec AND a supported audio codec before declaring any DirectPlay profile", () => {
    const videoOnly: CodecSupport = { video: { "mp4/h264": true }, audio: {} };
    expect(buildDeviceProfile(videoOnly, 8_000_000).DirectPlayProfiles).toEqual([]);
  });

  it("lets the HLS transcoding profile copy every supported video AND audio codec (not just h264/aac), so Jellyfin can remux instead of re-encoding streams that aren't the actual problem", () => {
    const support: CodecSupport = { video: { "mp4/h264": true, "mp4/hevc": true }, audio: { ac3: true, eac3: true } };
    const profile = buildDeviceProfile(support, 8_000_000);
    expect(profile.TranscodingProfiles[0].VideoCodec).toBe("h264,hevc");
    // Verified against a real Jellyfin server: hardcoding "aac" here made it needlessly
    // re-encode already-compatible AC3/EAC3 audio on every container-only remux.
    expect(profile.TranscodingProfiles[0].AudioCodec).toBe("ac3,eac3");
  });

  it("falls back to h264/aac in the transcoding profile when nothing is supported at all", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 8_000_000);
    expect(profile.TranscodingProfiles[0].VideoCodec).toBe("h264");
    expect(profile.TranscodingProfiles[0].AudioCodec).toBe("aac");
  });

  it("uses fMP4 (not MPEG-TS) segments for the HLS transcoding profile — hls.js doesn't reliably support HEVC muxed into raw .ts segments", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 8_000_000);
    expect(profile.TranscodingProfiles[0].Container).toBe("mp4");
  });

  it("declares HDR10/HLG/dual-layer-DolbyVision as an acceptable VideoRangeType for every supported video codec — without this Jellyfin tone-maps and fully re-encodes any HDR file even when a plain remux would do", () => {
    const support: CodecSupport = { video: { "mp4/hevc": true, "mp4/hevc10": true }, audio: { aac: true } };
    const profile = buildDeviceProfile(support, 8_000_000);
    expect(profile.CodecProfiles).toEqual([
      {
        Type: "Video",
        Codec: "hevc",
        Conditions: [{ Condition: "EqualsAny", Property: "VideoRangeType", Value: "SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithSDR", IsRequired: false }],
      },
    ]);
  });

  it("never declares bare DOVI (profile 5, no HDR10 fallback layer) as supported — that's genuinely Dolby-Vision-hardware-only", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 8_000_000);
    const values = profile.CodecProfiles.flatMap((p) => p.Conditions.map((c) => c.Value));
    for (const v of values) expect(v.split("|")).not.toContain("DOVI");
  });

  it("declares external VTT subtitle delivery, needed for embedded subtitles on a direct-played file", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 8_000_000);
    expect(profile.SubtitleProfiles).toContainEqual({ Format: "vtt", Method: "External" });
  });

  it("forwards maxBitrate to both the top-level profile and the streaming cap", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 12_345);
    expect(profile.MaxStreamingBitrate).toBe(12_345);
  });

  // HEVC Main and Main 10 are separate decoder capabilities, and this library is overwhelmingly
  // Main 10 — declaring one on the strength of the other is expensive in both directions.
  it("declares HEVC from either the 8-bit or the 10-bit probe", () => {
    for (const key of ["mp4/hevc", "mp4/hevc10"]) {
      const profile = buildDeviceProfile({ video: { [key]: true }, audio: { aac: true } }, 8_000_000);
      expect(profile.DirectPlayProfiles[0].VideoCodec).toContain("hevc");
    }
  });

  it("declares hevc once, not twice, when both probes pass", () => {
    const profile = buildDeviceProfile({ video: { "mp4/hevc": true, "mp4/hevc10": true }, audio: { aac: true } }, 8_000_000);
    expect(profile.DirectPlayProfiles[0].VideoCodec).toBe("hevc");
    expect(profile.CodecProfiles.filter((p) => p.Codec === "hevc")).toHaveLength(1);
  });

  // The safety half: advertising HEVC to a device that only decodes 8-bit would hand it a Main
  // 10 stream it cannot play — a black screen, where a slower transcode would have worked.
  it("caps HEVC at 8 bits when only the 8-bit probe passed", () => {
    const profile = buildDeviceProfile({ video: { "mp4/hevc": true }, audio: { aac: true } }, 8_000_000);
    const hevc = profile.CodecProfiles.find((p) => p.Codec === "hevc")!;
    expect(hevc.Conditions).toContainEqual({
      Condition: "LessThanEqual",
      Property: "VideoBitDepth",
      Value: "8",
      IsRequired: false,
    });
  });

  it("does not cap bit depth once 10-bit is proven, nor on other codecs", () => {
    const both = buildDeviceProfile({ video: { "mp4/hevc": true, "mp4/hevc10": true }, audio: { aac: true } }, 8_000_000);
    const h264 = buildDeviceProfile({ video: { "mp4/h264": true }, audio: { aac: true } }, 8_000_000);
    for (const profile of [both, h264]) {
      const properties = profile.CodecProfiles.flatMap((p) => p.Conditions.map((c) => c.Property));
      expect(properties).not.toContain("VideoBitDepth");
    }
  });
});

describe("le son ré-encodé — l'AAC à PCE de « Elle s'appelle Ruby »", () => {
  const support: CodecSupport = { video: { "mp4/h264": true }, audio: { aac: true, ac3: true, eac3: true } };

  it("en ambiance : plafond à 5 canaux, que Jellyfin ne peut pas copier et ré-encode en 5.1 standard", () => {
    // Mesuré le 10/10/2026 sur le vrai Jellyfin : `libfdk_aac -ac 6`, esds `11 b0` (5.1, sans PCE).
    const profile = buildDeviceProfile(support, 8_000_000, { reencodeAudio: "surround" });
    expect(profile.TranscodingProfiles[0].AudioCodec).toBe("aac");
    expect(profile.TranscodingProfiles[0].MaxAudioChannels).toBe("5");
    const audioConditions = profile.CodecProfiles.filter((p) => p.Type === "VideoAudio");
    expect(audioConditions.map((p) => p.Codec)).toEqual(["aac", "ac3", "eac3"]);
    for (const p of audioConditions) {
      expect(p.Conditions).toEqual([{ Condition: "LessThanEqual", Property: "AudioChannels", Value: "5", IsRequired: true }]);
    }
  });

  it("en stéréo, le dernier recours : plafond à 2 canaux", () => {
    const profile = buildDeviceProfile(support, 8_000_000, { reencodeAudio: "stereo" });
    expect(profile.TranscodingProfiles[0].AudioCodec).toBe("aac");
    expect(profile.TranscodingProfiles[0].MaxAudioChannels).toBe("2");
    for (const p of profile.CodecProfiles.filter((c) => c.Type === "VideoAudio")) {
      expect(p.Conditions).toEqual([{ Condition: "LessThanEqual", Property: "AudioChannels", Value: "2", IsRequired: true }]);
    }
  });

  it("ne change rien au profil ordinaire", () => {
    const profile = buildDeviceProfile(support, 8_000_000);
    expect(profile.TranscodingProfiles[0].AudioCodec).toBe("aac,ac3,eac3");
    expect(profile.TranscodingProfiles[0].MaxAudioChannels).toBe("6");
    expect(profile.CodecProfiles.some((p) => p.Type === "VideoAudio")).toBe(false);
  });
});

describe("audioNeedsReencode et chosenAudioStream", () => {
  it("reconnaît l'AAC multicanal sans disposition nommée — et lui seul", () => {
    expect(audioNeedsReencode({ Codec: "aac", Channels: 6 })).toBe(true);
    expect(audioNeedsReencode({ Codec: "aac", Channels: 6, ChannelLayout: "5.1" })).toBe(false);
    expect(audioNeedsReencode({ Codec: "aac", Channels: 2 })).toBe(false);
    expect(audioNeedsReencode({ Codec: "ac3", Channels: 6 })).toBe(false);
    expect(audioNeedsReencode(null)).toBe(false);
  });

  it("prend la piste demandée, sinon celle que Jellyfin retient par défaut", () => {
    const streams = [
      { Type: "Video", Index: 0 },
      { Type: "Audio", Index: 3 },
      { Type: "Audio", Index: 4 },
    ];
    expect(chosenAudioStream({ DefaultAudioStreamIndex: 4, MediaStreams: streams }, 3)?.Index).toBe(3);
    expect(chosenAudioStream({ DefaultAudioStreamIndex: 4, MediaStreams: streams }, undefined)?.Index).toBe(4);
    expect(chosenAudioStream({ MediaStreams: streams }, undefined)?.Index).toBe(3);
  });
});
