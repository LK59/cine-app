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
  // Either HEVC probe is enough to declare the codec itself; how deep that support goes is a
  // separate question, answered by the bit-depth condition below rather than by omitting the
  // codec entirely. A device that decodes 8-bit HEVC should still direct-play 8-bit HEVC.
  { key: "mp4/hevc", codec: "hevc" },
  { key: "mp4/hevc10", codec: "hevc" },
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
/**
 * Ce qui change quand le flux part vers un téléviseur plutôt que vers la page.
 *
 * Une seule chose, et elle est nécessaire : les sous-titres. `External` fait servir un fichier VTT
 * à côté, que **la page** va chercher et dessine elle-même en `<track>`. Sur une diffusion, c'est
 * le téléviseur qui lit le flux : il ne verra jamais ce que la page dessine, et le film partirait
 * sans sous-titres sans que rien ne le signale. `Hls` les fait entrer dans le manifeste, comme une
 * piste que le récepteur sait afficher — et que le téléphone continue de choisir, puisque ces
 * pistes apparaissent elles aussi dans `video.textTracks`.
 */
export interface DeviceProfileOptions {
  /** Les sous-titres doivent voyager dans le flux, pas à côté. */
  subtitlesInStream?: boolean;
}

export function buildDeviceProfile(
  support: CodecSupport,
  maxBitrate: number,
  options: DeviceProfileOptions = {}
): JellyfinDeviceProfile {
  const videoCodecs = [...new Set(VIDEO_CODEC_KEYS.filter((c) => support.video[c.key]).map((c) => c.codec))];
  // The other half of declaring HEVC honestly. Advertising the codec while the device only
  // decodes 8-bit would hand it a Main 10 stream it cannot play — a black screen instead of a
  // slower-but-working transcode, which is the worse failure by far. The condition tells
  // Jellyfin to fall back to a re-encode for 10-bit sources only, leaving 8-bit HEVC direct.
  const hevc10 = support.video["mp4/hevc10"] === true;
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
      Conditions: [
        { Condition: "EqualsAny", Property: "VideoRangeType", Value: SAFE_VIDEO_RANGES, IsRequired: false },
        ...(codec === "hevc" && !hevc10
          ? [{ Condition: "LessThanEqual", Property: "VideoBitDepth", Value: "8", IsRequired: false }]
          : []),
      ],
    })),
    // "External" is what makes Jellyfin extract embedded subtitle tracks (e.g. from an mkv
    // being direct-played, where the browser has no way to read them itself) as sidecar VTT,
    // served through the app's existing /api/jellyfin/stream/subtitle proxy. "Hls" covers the
    // Transcode path, where subtitles are embedded as a switchable HLS rendition instead.
    SubtitleProfiles: options.subtitlesInStream
      ? // Seul `Hls` : laisser `External` dans la liste rendrait à Jellyfin le droit de servir le
        // fichier à côté, c'est-à-dire exactement ce que le téléviseur ne saura pas lire.
        [{ Format: "vtt", Method: "Hls" }]
      : [
          { Format: "vtt", Method: "External" },
          { Format: "vtt", Method: "Hls" },
        ],
  };
}

/**
 * Pourquoi ce flux ne peut pas être diffusé tel quel — ou `null` s'il le peut.
 *
 * Un seul motif aujourd'hui, et il est net : un sous-titre fait d'**images** (PGS, VobSub) ne peut
 * pas devenir une piste du manifeste. Jellyfin n'a qu'un moyen de l'afficher, l'incruster dans
 * l'image — donc ré-encoder la vidéo. On perdrait la seule propriété qui rend cette diffusion
 * acceptable : la vidéo est **copiée** telle quelle, couche Dolby Vision comprise. Mesuré, pas
 * supposé : `TranscodeReasons` ne cite que le conteneur et l'audio.
 *
 * Le refuser en le disant vaut mieux que le transcoder en silence — un 4K qui part en ré-encodage
 * complet se voit sur la machine bien avant de se voir à l'écran. Et mieux que le diffuser sans
 * sous-titres, qui est la troisième option et la pire : elle ne prévient de rien.
 *
 * `IsTextSubtitleStream` absent veut dire « Jellyfin ne s'est pas prononcé » : on laisse passer.
 * Une hypothèse sur le serveur d'en face ne doit pas refuser une diffusion qui aurait marché.
 */
export function castRefusalFor(
  streams: { Type: string; Index: number; IsTextSubtitleStream?: boolean }[] | undefined,
  subtitleStreamIndex: number | null | undefined
): "image-subtitle" | null {
  if (subtitleStreamIndex === null || subtitleStreamIndex === undefined || subtitleStreamIndex < 0) return null;
  const chosen = streams?.find((s) => s.Type === "Subtitle" && s.Index === subtitleStreamIndex);
  if (!chosen) return null;
  return chosen.IsTextSubtitleStream === false ? "image-subtitle" : null;
}
