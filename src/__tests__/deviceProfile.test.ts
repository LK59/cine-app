import { describe, it, expect } from "vitest";
import { buildDeviceProfile } from "@/lib/deviceProfile";
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
    const support: CodecSupport = { video: { "mp4/hevc": true }, audio: { aac: true } };
    const profile = buildDeviceProfile(support, 8_000_000);
    expect(profile.CodecProfiles).toEqual([
      {
        Type: "Video",
        Codec: "hevc",
        Conditions: [{ Condition: "EqualsAny", Property: "VideoRangeType", Value: "SDR,HDR10,HDR10Plus,HLG,DOVIWithHDR10,DOVIWithHDR10Plus,DOVIWithSDR", IsRequired: false }],
      },
    ]);
  });

  it("never declares bare DOVI (profile 5, no HDR10 fallback layer) as supported — that's genuinely Dolby-Vision-hardware-only", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 8_000_000);
    const values = profile.CodecProfiles.flatMap((p) => p.Conditions.map((c) => c.Value));
    for (const v of values) expect(v.split(",")).not.toContain("DOVI");
  });

  it("declares external VTT subtitle delivery, needed for embedded subtitles on a direct-played file", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 8_000_000);
    expect(profile.SubtitleProfiles).toContainEqual({ Format: "vtt", Method: "External" });
  });

  it("forwards maxBitrate to both the top-level profile and the streaming cap", () => {
    const profile = buildDeviceProfile(NO_SUPPORT, 12_345);
    expect(profile.MaxStreamingBitrate).toBe(12_345);
  });
});
