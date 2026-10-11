import { describe, it, expect } from "vitest";
import { buildChromecastProfile, buildDeviceProfile, castTargetOf } from "@/lib/deviceProfile";
import type { CodecSupport } from "@/lib/codecSupport";

// DECISIONS.md §64 — le profil du Chromecast, à part de celui d'AirPlay qui ne bouge pas.

describe("buildChromecastProfile — ce que tous les Chromecast lisent", () => {
  const profile = buildChromecastProfile(20_000_000);

  it("H.264 seul, en lecture directe comme en transcodage — jamais HEVC, VP9 ni AV1 annoncés", () => {
    expect(profile.DirectPlayProfiles).toEqual([{ Container: "mp4,m4v", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,ac3,eac3" }]);
    expect(profile.TranscodingProfiles).toEqual([
      { Container: "mp4", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,ac3,eac3", Protocol: "hls", Context: "Streaming", MaxAudioChannels: "6" },
    ]);
    expect(JSON.stringify(profile)).not.toMatch(/hevc|vp9|av1/i);
  });

  it("SDR, 8 bits, niveau 4.2, 1080p au plus : un fichier HDR ou 4K est transcodé, pas envoyé tel quel", () => {
    const conditions = profile.CodecProfiles.find((p) => p.Codec === "h264")!.Conditions;
    const byProperty = Object.fromEntries(conditions.map((c) => [c.Property, c.Value]));
    expect(byProperty).toEqual({
      VideoRangeType: "SDR",
      VideoBitDepth: "8",
      VideoLevel: "42",
      VideoProfile: "high|main|baseline|constrained baseline",
      Width: "1920",
      Height: "1080",
    });
  });

  it("jamais DTS, TrueHD ni FLAC copiés", () => {
    for (const codec of ["dts", "truehd", "flac", "opus"]) expect(JSON.stringify(profile)).not.toContain(codec);
  });

  it("sous-titres texte servis à côté en WebVTT, images incrustées par le serveur", () => {
    expect(profile.SubtitleProfiles).toEqual([
      { Format: "vtt", Method: "External" },
      { Format: "pgssub", Method: "Encode" },
      { Format: "dvdsub", Method: "Encode" },
      { Format: "dvbsub", Method: "Encode" },
      { Format: "xsub", Method: "Encode" },
    ]);
  });

  it("le débit demandé est le plafond", () => {
    expect(profile.MaxStreamingBitrate).toBe(20_000_000);
  });

  it("un AAC à PCE : ré-encodé en AAC 5.1, comme sur la page", () => {
    const surround = buildChromecastProfile(20_000_000, { reencodeAudio: "surround" });
    expect(surround.TranscodingProfiles[0].AudioCodec).toBe("aac");
    expect(surround.TranscodingProfiles[0].MaxAudioChannels).toBe("5");
    expect(surround.CodecProfiles.filter((p) => p.Type === "VideoAudio")).toEqual([
      { Type: "VideoAudio", Codec: "aac", Conditions: [{ Condition: "LessThanEqual", Property: "AudioChannels", Value: "5", IsRequired: true }] },
    ]);
  });
});

describe("castTargetOf — la seule valeur reconnue", () => {
  it("« chromecast » et rien d'autre", () => {
    expect(castTargetOf("chromecast")).toBe("chromecast");
    for (const other of ["airplay", "Chromecast", "", null, undefined, 1, {}]) expect(castTargetOf(other)).toBeNull();
  });
});

/**
 * Le profil d'AirPlay, figé octet pour octet : le Chromecast a le sien, et l'ajouter ne devait rien
 * changer à celui-là (zéro régression). Un iPhone typique : H.264, HEVC 10 bits, AAC, AC-3, E-AC3.
 */
describe("le profil d'une diffusion AirPlay ne change pas", () => {
  it("identique à ce qu'il était avant le Chromecast", () => {
    const iphone: CodecSupport = {
      video: { "mp4/h264": true, "mp4/hevc": true, "mp4/hevc10": true },
      audio: { aac: true, ac3: true, eac3: true, flac: true },
    };
    expect(buildDeviceProfile(iphone, 8_000_000, { subtitlesInStream: true })).toEqual({
      MaxStreamingBitrate: 8_000_000,
      DirectPlayProfiles: [{ Container: "mp4,m4v", Type: "Video", VideoCodec: "h264,hevc", AudioCodec: "aac,ac3,eac3,flac" }],
      TranscodingProfiles: [
        { Container: "mp4", Type: "Video", VideoCodec: "h264,hevc", AudioCodec: "aac,ac3,eac3,flac", Protocol: "hls", Context: "Streaming", MaxAudioChannels: "6" },
      ],
      CodecProfiles: [
        {
          Type: "Video",
          Codec: "h264",
          Conditions: [{ Condition: "EqualsAny", Property: "VideoRangeType", Value: "SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithSDR", IsRequired: false }],
        },
        {
          Type: "Video",
          Codec: "hevc",
          Conditions: [{ Condition: "EqualsAny", Property: "VideoRangeType", Value: "SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithSDR", IsRequired: false }],
        },
      ],
      SubtitleProfiles: [{ Format: "vtt", Method: "Hls" }],
    });
  });
});
