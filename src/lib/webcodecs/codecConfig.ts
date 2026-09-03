// Translates a Matroska track into the configuration WebCodecs wants.
//
// `VideoDecoder.configure()` takes a codec string that carries the exact profile, level and
// constraints — not just "hevc" — because that string is what the browser matches against its
// hardware decoder's capabilities. Getting it wrong doesn't degrade gracefully: the decoder
// either refuses the configuration or, worse, accepts it and produces garbage. The values all
// come out of CodecPrivate, which holds the same configuration record an MP4 would store.

import type { MatroskaTrack } from "./matroska";

export interface DecoderConfig {
  codec: string;
  /** The codec-private bytes a decoder needs to make sense of the samples. */
  description?: Uint8Array;
}

export interface VideoConfig extends DecoderConfig {
  codedWidth: number;
  codedHeight: number;
}

export interface AudioConfig extends DecoderConfig {
  sampleRate: number;
  numberOfChannels: number;
}

// AC3 and E-AC3 are worth *asking* for rather than assuming: they are not part of the web
// platform's baseline, but they are decoded natively by the operating system on Apple devices
// and on Windows, and WebCodecs exposes whatever the platform provides. Configuring them and
// letting AudioDecoder.isConfigSupported() answer costs nothing and, where it says yes, turns a
// silent film into a working one. Where it says no, the engine reports exactly that.
//
// DTS and TrueHD have no platform decoder anywhere and no codec string in the registry, so they
// are refused up front instead of being asked about.
/**
 * Codecs no browser decodes, split by whether there is a decoder for them here.
 *
 * The distinction is what the viewer is told. Saying "it would need the software decoder" about
 * TrueHD implies one exists and could be reached for; there is none, in this ecosystem or any
 * other that ships to a browser — mediabunny publishes decoders for DTS and Dolby Digital and
 * nothing for MLP. Measured on this library: 35 files carry TrueHD and 33 of them carry a Dolby
 * or DTS track beside it, which is what plays.
 */
export const SOFTWARE_AUDIO_CODECS = new Set(["A_DTS", "A_DTS/EXPRESS", "A_DTS/LOSSLESS"]);
export const UNDECODABLE_ANYWHERE = new Set(["A_TRUEHD", "A_MLP"]);

function hex(value: number, digits = 2): string {
  return value.toString(16).toUpperCase().padStart(digits, "0");
}

// The profile-compatibility field is written with its bits in reverse order — a quirk of the
// codec-string spec, not of the file. Chrome compares the string it is given against one it
// builds this same way, so a straight hex dump of the field simply never matches.
function reverseBits32(value: number): number {
  let out = 0;
  for (let i = 0; i < 32; i++) {
    out = (out << 1) | ((value >>> i) & 1);
  }
  return out >>> 0;
}

/**
 * Builds an `hvc1.*` string from the hvcC record Matroska stores in CodecPrivate.
 * Layout: [0] version, [1] profile_space<<6 | tier<<5 | profile_idc,
 * [2..5] compatibility flags, [6..11] constraint flags, [12] level.
 */
export function hevcCodecString(hvcC: Uint8Array): string | null {
  if (hvcC.length < 13) return null;

  const profileSpace = (hvcC[1] >> 6) & 0x03;
  const tier = (hvcC[1] >> 5) & 0x01;
  const profileIdc = hvcC[1] & 0x1f;
  const compatibility = reverseBits32((hvcC[2] << 24) | (hvcC[3] << 16) | (hvcC[4] << 8) | hvcC[5]);
  const level = hvcC[12];

  const space = ["", "A", "B", "C"][profileSpace];
  const constraints: string[] = [];
  for (let i = 6; i <= 11; i++) constraints.push(hex(hvcC[i]));
  // Trailing zero constraint bytes are omitted by convention; keeping them produces a string no
  // browser recognises.
  while (constraints.length && constraints[constraints.length - 1] === "00") constraints.pop();

  return [
    `hvc1.${space}${profileIdc}`,
    compatibility.toString(16).toUpperCase(),
    `${tier ? "H" : "L"}${level}`,
    ...constraints,
  ].join(".");
}

/** Builds an `avc1.*` string from the avcC record: profile, compatibility and level. */
export function avcCodecString(avcC: Uint8Array): string | null {
  if (avcC.length < 4) return null;
  // Lower-case hex here, upper-case for HEVC: that split is what the codec-string conventions
  // actually use, and browsers are picky about the whole token matching.
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`.toLowerCase();
}

/** Builds an `av01.*` string from the av1C record. */
export function av1CodecString(av1C: Uint8Array): string | null {
  if (av1C.length < 2) return null;
  const profile = (av1C[1] >> 5) & 0x07;
  const level = av1C[1] & 0x1f;
  const tier = (av1C[2] >> 7) & 0x01;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.08`;
}

export function videoConfigFor(track: MatroskaTrack): VideoConfig | null {
  if (track.type !== "video" || !track.video) return null;
  const size = { codedWidth: track.video.width, codedHeight: track.video.height };
  const priv = track.codecPrivate;

  switch (track.codecId) {
    case "V_MPEGH/ISO/HEVC": {
      if (!priv) return null;
      const codec = hevcCodecString(priv);
      return codec ? { codec, description: priv, ...size } : null;
    }
    case "V_MPEG4/ISO/AVC": {
      if (!priv) return null;
      const codec = avcCodecString(priv);
      return codec ? { codec, description: priv, ...size } : null;
    }
    case "V_AV1": {
      const codec = priv ? av1CodecString(priv) : "av01.0.08M.08";
      return codec ? { codec, ...(priv ? { description: priv } : {}), ...size } : null;
    }
    case "V_VP9":
      // VP9 carries everything it needs in-band; the profile in the string is advisory.
      return { codec: "vp09.00.10.08", ...size };
    case "V_VP8":
      return { codec: "vp8", ...size };
    default:
      return null;
  }
}

/**
 * Every configuration worth offering for a track, best first.
 *
 * Codec strings for AC3 and E-AC3 are not as settled as the video ones — the registry says
 * "ac-3" and "ec-3", but implementations have shipped other spellings, and a platform that
 * refuses one may accept another. Since the only cost of asking is one isConfigSupported call,
 * the engine tries them in order rather than betting on a single string.
 */
export function audioConfigCandidates(track: MatroskaTrack): AudioConfig[] {
  const primary = audioConfigFor(track);
  if (!primary) return [];
  const alternatives: Record<string, string[]> = {
    A_AC3: ["ac-3", "ac3", "mp4a.a5"],
    A_EAC3: ["ec-3", "eac3", "ec3", "mp4a.a6"],
  };
  const spellings = alternatives[track.codecId];
  if (!spellings) return [primary];
  return spellings.map((codec) => ({ ...primary, codec }));
}

export function audioConfigFor(track: MatroskaTrack): AudioConfig | null {
  if (track.type !== "audio" || !track.audio) return null;
  const base = { sampleRate: Math.round(track.audio.sampleRate), numberOfChannels: track.audio.channels };
  const priv = track.codecPrivate;

  switch (track.codecId) {
    case "A_AAC":
      // The AudioSpecificConfig is mandatory for AAC in Matroska; without it the decoder cannot
      // know the profile or whether SBR doubles the output rate.
      return priv ? { codec: "mp4a.40.2", description: priv, ...base } : null;
    case "A_OPUS":
      return { codec: "opus", ...(priv ? { description: priv } : {}), ...base };
    case "A_FLAC":
      return { codec: "flac", ...(priv ? { description: priv } : {}), ...base };
    case "A_MPEG/L3":
      return { codec: "mp3", ...base };
    case "A_AC3":
      return { codec: "ac-3", ...base };
    case "A_EAC3":
      return { codec: "ec-3", ...base };
    case "A_VORBIS":
      return { codec: "vorbis", ...(priv ? { description: priv } : {}), ...base };
    case "A_PCM/INT/LIT":
      return { codec: track.audio.bitDepth === 16 ? "pcm-s16" : "pcm-f32", ...base };
    default:
      return null;
  }
}

/** Why a track cannot be played, phrased for the error the user actually sees. */
export function unsupportedReason(track: MatroskaTrack): string | null {
  if (track.type === "video") {
    if (videoConfigFor(track)) return null;
    if (!track.codecPrivate && (track.codecId === "V_MPEGH/ISO/HEVC" || track.codecId === "V_MPEG4/ISO/AVC")) {
      return `La piste vidéo ${track.codecId} n'a pas de configuration de décodeur dans le fichier.`;
    }
    return `Codec vidéo non pris en charge par le lecteur expérimental : ${track.codecId}.`;
  }
  if (track.type === "audio") {
    if (audioConfigFor(track)) return null;
    if (SOFTWARE_AUDIO_CODECS.has(track.codecId)) {
      return `L'audio ${track.codecId.replace("A_", "")} n'a de décodeur sur aucune plateforme — il faudrait le décodeur logiciel.`;
    }
    if (UNDECODABLE_ANYWHERE.has(track.codecId)) {
      return `L'audio ${track.codecId.replace("A_", "")} n'a de décodeur nulle part, pas même logiciel. Choisis une autre piste.`;
    }
    return `Codec audio non pris en charge : ${track.codecId}.`;
  }
  return null;
}

/**
 * How many bytes each NAL unit's length prefix takes, from the codec's own configuration record.
 *
 * Four in practice, and the field exists because it is not guaranteed. Reading it wrong turns
 * the walk below into nonsense, which is worse than not walking at all — hence the default only
 * when the record is too short to say.
 */
export function nalLengthSize(codecId: string, codecPrivate: Uint8Array | null): number {
  if (!codecPrivate) return 4;
  if (codecId === "V_MPEGH/ISO/HEVC") return codecPrivate.length > 21 ? (codecPrivate[21] & 0x03) + 1 : 4;
  if (codecId === "V_MPEG4/ISO/AVC") return codecPrivate.length > 4 ? (codecPrivate[4] & 0x03) + 1 : 4;
  return 4;
}

/**
 * Whether a decoder may actually start on this picture.
 *
 * Matroska marks a block as a keyframe when it carries no reference to another block, and an
 * encoder is free to emit an intra picture that satisfies that while the pictures decoded after
 * it still reference frames from before. One real file marks four such pictures every two
 * minutes — 19% of what it calls its keyframes — and they are not random access points at all.
 *
 * Starting there produces a decode that cannot complete. ffmpeg says "Could not find ref with
 * POC -35" and carries on without those frames; Safari answers "media failed to decode" and
 * closes the MediaSource, taking the picture with it. Measured on the device: a segment opening
 * at 1944.240 s killed it every time, and one opening at the genuine CRA a second earlier played
 * through the identical stretch.
 *
 * So the picture is asked what it is. The first NAL unit is often a prefix SEI, so the slice has
 * to be looked for rather than assumed to be at the front.
 */
export function isRandomAccessPoint(data: Uint8Array, codecId: string, lengthSize: number): boolean {
  const hevc = codecId === "V_MPEGH/ISO/HEVC";
  if (!hevc && codecId !== "V_MPEG4/ISO/AVC") return true; // nothing to read; trust the container

  for (let at = 0; at + lengthSize + 1 <= data.byteLength; ) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + data[at + i];
    if (length <= 0 || at + lengthSize + length > data.byteLength) break;

    const header = data[at + lengthSize];
    if (hevc) {
      const type = (header >> 1) & 0x3f;
      // 32 and above are parameter sets and SEI; the first below that is the picture itself.
      if (type <= 31) return type >= 16 && type <= 23; // BLA, IDR and CRA
    } else {
      const type = header & 0x1f;
      if (type === 1 || type === 5) return type === 5; // a slice: IDR or not
    }
    at += lengthSize + length;
  }
  // Nothing legible. The container's own word is all there is, and it said keyframe to get here.
  return true;
}
