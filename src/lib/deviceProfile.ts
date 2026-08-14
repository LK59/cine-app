import type { CodecSupport } from "@/lib/codecSupport";

export interface JellyfinDeviceProfile {
  MaxStreamingBitrate: number;
  DirectPlayProfiles: { Container: string; Type: "Video"; VideoCodec: string; AudioCodec: string }[];
  TranscodingProfiles: {
    Container: string;
    Type: "Video";
    VideoCodec: string;
    AudioCodec: string;
    Protocol: string;
    Context: string;
    MaxAudioChannels: string;
  }[];
  CodecProfiles: {
    Type: "Video";
    Codec: string;
    Conditions: { Condition: string; Property: string; Value: string; IsRequired: boolean }[];
  }[];
  SubtitleProfiles: { Format: string; Method: string }[];
}

// Maps codecSupport.ts's "container/codec" keys to the plain codec names Jellyfin's
// DeviceProfile expects.
const VIDEO_CODEC_KEYS: { key: string; codec: string }[] = [
  { key: "mp4/h264", codec: "h264" },
  { key: "mp4/hevc", codec: "hevc" },
  { key: "mp4/vp9", codec: "vp9" },
  { key: "mp4/av1", codec: "av1" },
];

// Without an explicit VideoRangeType condition, Jellyfin doesn't just risk a "might look
// slightly flat" fallback for HDR content — verified against the real server that it instead
// tone-maps AND fully re-encodes (GPU-transcodes) every single HDR file unconditionally, even
// when video+audio would otherwise just need a plain container remux. That's a real, systematic
// cost (defeats DirectStream for a large chunk of an HEVC-heavy library), not a rare edge case.
//
// This list is safe to declare universally, with no per-browser detection needed: Dolby
// Vision's dual-layer profiles (7, 8.x — effectively all real-world DV files) embed a standard
// HDR10 fallback layer specifically so a non-DV-aware decoder can play the file correctly using
// just that layer, per the format's own design — any browser that already decodes HEVC Main10
// handles this the same way it handles plain HDR10, no special support needed. Deliberately
// excludes bare "DOVI" (profile 5, no fallback layer) — genuinely Dolby-Vision-hardware-only,
// essentially Apple only, and declaring it "supported" everywhere would be actively wrong.
// Jellyfin's EqualsAny condition expects its multi-value Value string pipe-separated, not
// comma-separated — verified against the real server after a comma-separated value shipped
// silently matched nothing, making every file (SDR included) fail with VideoRangeTypeNotSupported.
const SAFE_VIDEO_RANGES = "SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithSDR";

// Builds the DeviceProfile POSTed to /Items/{id}/PlaybackInfo, letting Jellyfin's own
// StreamBuilder pick DirectPlay / DirectStream (remux) / Transcode — same model as
// jellyfin-web, replacing the previous "always transcode everything" DeviceProfile (empty
// DirectPlayProfiles) that traded server load for never having to declare real capabilities.
//
// DirectPlayProfiles only ever declares "mp4" as the container — never "mkv", even when a
// browser can decode a file's codecs just fine, because none of the target browsers natively
// demux raw Matroska via a plain <video src>. Declaring mp4 is what lets Jellyfin's
// StreamBuilder do the rest on its own: an mp4-native file with compatible codecs plays
// untouched (DirectPlay), an mkv file with compatible codecs gets remuxed server-side without
// re-encoding, and only a genuine codec mismatch falls through to a real Transcode.
export function buildDeviceProfile(support: CodecSupport, maxBitrate: number): JellyfinDeviceProfile {
  const videoCodecs = VIDEO_CODEC_KEYS.filter((c) => support.video[c.key]).map((c) => c.codec);
  const audioCodecs = Object.entries(support.audio)
    .filter(([, supported]) => supported)
    .map(([codec]) => codec);

  const directPlayProfiles: JellyfinDeviceProfile["DirectPlayProfiles"] =
    videoCodecs.length && audioCodecs.length
      ? [{ Container: "mp4,m4v", Type: "Video", VideoCodec: videoCodecs.join(","), AudioCodec: audioCodecs.join(",") }]
      : [];

  return {
    MaxStreamingBitrate: maxBitrate,
    DirectPlayProfiles: directPlayProfiles,
    TranscodingProfiles: [
      {
        // fMP4 segments (Jellyfin's HLS + Container:"mp4" produces CMAF-style .mp4 segments
        // with an EXT-X-MAP init segment), not raw MPEG-TS. Verified against a real server and
        // a real playback failure: with Container:"ts", a copied (non-re-encoded) HEVC stream
        // gets muxed into plain .ts segments, which hls.js's own JS TS demuxer/remuxer does not
        // reliably support for HEVC — every DirectStream remux of an HEVC file failed with a
        // fatal hls.js error a few seconds in, regardless of resolution/HDR. fMP4 is what
        // hls.js and native HLS actually support for HEVC (MSE natively understands fMP4
        // boxes, no JS-side remuxing needed), and jellyfin-web itself defaults to it.
        Container: "mp4",
        Type: "Video",
        // Lists every codec this browser can decode — not just h264/aac — so Jellyfin can
        // copy the source video AND audio streams untouched (no re-encode of either) when the
        // only real problem is the container (e.g. an mkv with h264+ac3, both already fine).
        // Verified against a real server: leaving AudioCodec hardcoded to "aac" here made
        // Jellyfin re-encode already-browser-compatible AC3/EAC3 audio for no reason on every
        // container-only remux.
        VideoCodec: (videoCodecs.length ? videoCodecs : ["h264"]).join(","),
        AudioCodec: (audioCodecs.length ? audioCodecs : ["aac"]).join(","),
        Protocol: "hls",
        Context: "Streaming",
        MaxAudioChannels: "6",
      },
    ],
    CodecProfiles: (videoCodecs.length ? videoCodecs : ["h264"]).map((codec) => ({
      Type: "Video" as const,
      Codec: codec,
      Conditions: [{ Condition: "EqualsAny", Property: "VideoRangeType", Value: SAFE_VIDEO_RANGES, IsRequired: false }],
    })),
    // "External" is what makes Jellyfin extract embedded subtitle tracks (e.g. from an mkv
    // being direct-played, where the browser has no way to read them itself) as sidecar VTT,
    // served through the app's existing /api/jellyfin/stream/subtitle proxy. "Hls" covers the
    // Transcode path, where subtitles are embedded as a switchable HLS rendition instead.
    SubtitleProfiles: [
      { Format: "vtt", Method: "External" },
      { Format: "vtt", Method: "Hls" },
    ],
  };
}
