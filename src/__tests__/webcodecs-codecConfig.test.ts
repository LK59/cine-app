import { describe, it, expect } from "vitest";
import { strayUnits, isRandomAccessPoint, nalLengthSize,
  hevcCodecString,
  avcCodecString,
  av1CodecString,
  audioConfigFor,
} from "@/lib/webcodecs/codecConfig";
import { subtitleText } from "@/lib/webcodecs/subtitleMarkup";
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
    isHearingImpaired: false,
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

});

describe("audio decoder configuration", () => {
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
  // would be theatre: they go to our own software decoders (softwareAudio.ts).
  it("has no platform configuration for DTS and TrueHD", () => {
    for (const codecId of ["A_DTS", "A_DTS/EXPRESS", "A_DTS/LOSSLESS", "A_TRUEHD", "A_MLP"]) {
      const t = track({ type: "audio", codecId, audio: { sampleRate: 48000, channels: 8 } });
      expect(audioConfigFor(t)).toBeNull();
    }
  });

  it("passes Opus, FLAC and MP3 straight through", () => {
    const base = { type: "audio" as const, audio: { sampleRate: 48000, channels: 2 } };
    expect(audioConfigFor(track({ ...base, codecId: "A_OPUS" }))?.codec).toBe("opus");
    expect(audioConfigFor(track({ ...base, codecId: "A_FLAC" }))?.codec).toBe("flac");
    expect(audioConfigFor(track({ ...base, codecId: "A_MPEG/L3" }))?.codec).toBe("mp3");
  });
});

describe("subtitle text extraction", () => {
  it("passes plain SRT through untouched", () => {
    expect(subtitleText("Bonjour\nle monde", "S_TEXT/UTF8")).toBe("Bonjour\nle monde");
  });

  // Le symptôme, trouvé sur Titanic : ses quatre pistes sont du SubRip *interne* au Matroska, et
  // ce chemin-là ne nettoyait rien — une réplique en italique s'affichait entourée de ses balises.
  // Les fichiers posés à côté du film, eux, étaient nettoyés depuis toujours ; c'est la même
  // fonction qui sert maintenant aux deux.
  it("retire les balises d'un SubRip interne", () => {
    expect(subtitleText("<i>Pour que ça compte.</i>", "S_TEXT/UTF8")).toBe("Pour que ça compte.");
  });

  // Une balise ouverte sur une ligne et fermée sur la suivante est la forme normale d'une
  // réplique de deux lignes — c'est exactement ce que Jellyfin renvoie pour ce film.
  it("retire une balise qui enjambe deux lignes", () => {
    expect(subtitleText("<i>Pour que ça compte.\nRendez-vous à la pendule.</i>", "S_TEXT/UTF8")).toBe(
      "Pour que ça compte.\nRendez-vous à la pendule."
    );
  });

  it("retire aussi les balises à attributs", () => {
    expect(subtitleText('<font color="#ffffff">Blanc</font>', "S_TEXT/UTF8")).toBe("Blanc");
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

  // Blu-ray et télévision : l'image clé est une image I derrière un SEI « recovery point », pas une
  // IDR. Supernatural S15E20 n'a qu'une IDR en 43 minutes (24/09/2026).
  describe("AVC, point de reprise", () => {
    // SEI : type 6, taille 1, recovery_frame_cnt ue(0) = « 1 », exact_match 1, broken_link 0,
    // changing_slice_group_idc 00, puis l'alignement « 100 » ; enfin le bit d'arrêt du RBSP.
    const recoveryPoint = [0x06, 0x06, 0x01, 0xc4, 0x80];
    // recovery_frame_cnt = 2 : ue(2) = « 011 », puis 1, 0, 00 et l'alignement « 1 » : 0110 1001.
    const gradualRecovery = [0x06, 0x06, 0x01, 0x69, 0x80];
    // Une autre SEI (type 5, données non enregistrées) devant.
    const otherSei = [0x06, 0x05, 0x01, 0x00, 0x80];
    // Tranche non IDR : first_mb ue(0) = « 1 », slice_type ue(7) = « 0001000 » → I.
    const intraSlice = [0x61, 0x88, 0x80];
    // slice_type ue(5) = « 00110 » → P.
    const predictedSlice = [0x61, 0x98, 0x80];

    it("accepts an intra picture behind a recovery point", () => {
      expect(isRandomAccessPoint(sample(recoveryPoint, intraSlice), "V_MPEG4/ISO/AVC", 4)).toBe(true);
      expect(isRandomAccessPoint(sample(otherSei, recoveryPoint, intraSlice), "V_MPEG4/ISO/AVC", 4)).toBe(true);
    });

    it("still refuses a bare I slice, a predicted one, and a recovery that takes frames", () => {
      expect(isRandomAccessPoint(sample(intraSlice), "V_MPEG4/ISO/AVC", 4)).toBe(false);
      expect(isRandomAccessPoint(sample(otherSei, intraSlice), "V_MPEG4/ISO/AVC", 4)).toBe(false);
      expect(isRandomAccessPoint(sample(recoveryPoint, predictedSlice), "V_MPEG4/ISO/AVC", 4)).toBe(false);
      expect(isRandomAccessPoint(sample(gradualRecovery, intraSlice), "V_MPEG4/ISO/AVC", 4)).toBe(false);
    });
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

describe("av1CodecString", () => {
  /** An AV1CodecConfigurationRecord: marker and version, profile and level, then the flags. */
  const record = (profile: number, level: number, tier: number, high: number, twelve: number) =>
    new Uint8Array([0x81, (profile << 5) | level, (tier << 7) | (high << 6) | (twelve << 5), 0]);

  it("reads the bit depth instead of assuming eight", () => {
    // Written as .08 whatever the stream was, this described a ten-bit file to a decoder as
    // eight — a claim the browser is entitled to act on.
    expect(av1CodecString(record(0, 8, 0, 0, 0))).toBe("av01.0.08M.08");
    expect(av1CodecString(record(0, 8, 0, 1, 0))).toBe("av01.0.08M.10");
    // Twelve bits exist only in profile 2; elsewhere the flag means ten.
    expect(av1CodecString(record(2, 8, 0, 1, 1))).toBe("av01.2.08M.12");
    expect(av1CodecString(record(0, 8, 0, 1, 1))).toBe("av01.0.08M.10");
  });

  it("names the tier and pads the level", () => {
    expect(av1CodecString(record(0, 5, 1, 1, 0))).toBe("av01.0.05H.10");
    expect(av1CodecString(record(1, 13, 0, 1, 0))).toBe("av01.1.13M.10");
  });

  it("refuses a record it cannot read rather than inventing one", () => {
    expect(av1CodecString(new Uint8Array([0x81, 0x00]))).toBeNull();
    // Three bytes is what it reads, and three is enough.
    expect(av1CodecString(new Uint8Array([0x81, 0x08, 0x40]))).toBe("av01.0.08M.10");
    // A record whose version byte is not the one the specification defines.
    expect(av1CodecString(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBeNull();
  });
});

describe("strayUnits", () => {
  const unit = (...nal: number[]) => [0, 0, 0, nal.length, ...nal];
  const sample = (...nals: number[][]) => new Uint8Array(nals.flatMap((nal) => unit(...nal)));
  const hevcNal = (type: number, ...rest: number[]) => [(type << 1) & 0xfe, 1, ...rest];
  const HEVC = "V_MPEGH/ISO/HEVC";

  it("returns Dirty Dancing's picture-less block to the pictures it was cut from", () => {
    // Block 60 of the real file, NAL types [32, 33, 34, 62], timed as a picture; block 59, the
    // picture before it, is the only one with no RPU. As a sample of its own it closed Safari's
    // MediaSource at every CRA it preceded.
    const vps = hevcNal(32, 1), sps = hevcNal(33, 2), pps = hevcNal(34, 3), rpu = hevcNal(62, 4);
    const stray = strayUnits(sample(vps, sps, pps, rpu), HEVC, 4);
    // The RPU closes the picture before; the parameter sets open the one after, ahead of its slice.
    expect(stray?.before.map((u) => [...u])).toEqual([unit(...rpu)]);
    expect(stray?.after.map((u) => [...u])).toEqual([unit(...vps), unit(...sps), unit(...pps)]);
  });

  it("leaves every block with a slice alone, leading pictures included", () => {
    for (const type of [0, 1, 8, 9, 19, 20, 21]) {
      expect(strayUnits(sample(hevcNal(32, 0), hevcNal(39, 0), hevcNal(type, 0x80), hevcNal(62, 0)), HEVC, 4)).toBeNull();
    }
  });

  it("sends suffix SEI and end of sequence back, prefix SEI forward", () => {
    const stray = strayUnits(sample(hevcNal(40, 0), hevcNal(36), hevcNal(39, 0)), HEVC, 4);
    expect(stray?.before.length).toBe(2);
    expect(stray?.after.length).toBe(1);
  });

  it("reads H.264, where everything outside a slice goes forward", () => {
    expect(strayUnits(sample([0x67, 0], [0x68, 0]), "V_MPEG4/ISO/AVC", 4)?.after.length).toBe(2);
    expect(strayUnits(sample([0x06, 0], [0x65, 0x88]), "V_MPEG4/ISO/AVC", 4)).toBeNull();
  });

  it("trusts the container when there is nothing legible, or nothing to read", () => {
    expect(strayUnits(new Uint8Array([0, 0, 0, 99, 0x40]), HEVC, 4)).toBeNull();
    expect(strayUnits(new Uint8Array(0), HEVC, 4)).toBeNull();
    expect(strayUnits(new Uint8Array([1, 2, 3]), "V_AV1", 4)).toBeNull();
  });

  it("is applied by the remuxer to every video block it reads", async () => {
    // It had two readers until 2026-09-24 — the remuxer and the canvas engine, removed since.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/lib/webcodecs/remuxer.ts", "utf8")).toMatch(/const stray = strayUnits\(sample\.data,/);
  });
});
