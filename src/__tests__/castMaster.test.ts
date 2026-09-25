import { describe, it, expect } from "vitest";
import { castMasterPlaylist } from "@/lib/castMaster";

// Relevé sur *Ted Lasso* S01E05 (4K Dolby Vision) le 25/09/2026 : une copie HDR et deux secours
// SDR ré-encodés, au même débit déclaré. En diffusion, le téléviseur basculait sur un secours après
// un saut et s'y enfermait.
const MASTER = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Français",URI="x/Subtitles/4/subtitles.m3u8?a=1"',
  '#EXT-X-STREAM-INF:BANDWIDTH=12208123,VIDEO-RANGE=PQ,CODECS="hvc1.2.4.L153.B0,ec-3",SUPPLEMENTAL-CODECS="dvh1.08.06/db1p",SUBTITLES="subs"',
  "main.m3u8?VideoCodec=h264,hevc&AudioCodec=copy",
  '#EXT-X-STREAM-INF:BANDWIDTH=12208123,VIDEO-RANGE=SDR,CODECS="hvc1.2.4.L150.B0,ec-3",SUBTITLES="subs"',
  "main.m3u8?VideoCodec=hevc&AudioCodec=copy",
  '#EXT-X-STREAM-INF:BANDWIDTH=12208123,VIDEO-RANGE=SDR,CODECS="avc1.424029,ec-3",SUBTITLES="subs"',
  "main.m3u8?VideoCodec=h264&AudioCodec=copy",
  '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=5564,URI="Trickplay/320/tiles.m3u8?a=1"',
  "",
].join("\n");

describe("castMasterPlaylist", () => {
  it("ne garde que la copie HDR, et tout le reste du maître", () => {
    const out = castMasterPlaylist(MASTER);
    expect(out.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);
    expect(out).toContain("VIDEO-RANGE=PQ");
    expect(out).toContain("main.m3u8?VideoCodec=h264,hevc&AudioCodec=copy");
    expect(out).not.toContain("VideoCodec=hevc&");
    expect(out).not.toContain("VideoCodec=h264&");
    expect(out).toContain("#EXT-X-MEDIA:TYPE=SUBTITLES");
    expect(out).toContain("#EXT-X-IMAGE-STREAM-INF");
  });

  it("laisse intact un maître SDR, ou d'une seule variante", () => {
    const sdr = MASTER.replace("VIDEO-RANGE=PQ", "VIDEO-RANGE=SDR");
    expect(castMasterPlaylist(sdr)).toBe(sdr);
    const single = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,VIDEO-RANGE=PQ\nmain.m3u8\n";
    expect(castMasterPlaylist(single)).toBe(single);
  });

  it("laisse intact un playlist de segments", () => {
    const media = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhls1/main/0.mp4\n";
    expect(castMasterPlaylist(media)).toBe(media);
  });
});
