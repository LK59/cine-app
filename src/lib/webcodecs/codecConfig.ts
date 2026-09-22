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
 * Codecs no browser decodes, for which there is a decoder here.
 *
 * TrueHD and MLP joined DTS on 21/09/2026: until then nothing decoded them in a browser —
 * mediabunny publishes decoders for DTS and Dolby Digital only — and a separate list said so,
 * because telling the viewer "it would need the software decoder" implied one existed. FFmpeg's
 * decoder, compiled to WebAssembly (tools/truehd-wasm), is that decoder now.
 */
export const SOFTWARE_AUDIO_CODECS = new Set(["A_DTS", "A_DTS/EXPRESS", "A_DTS/LOSSLESS", "A_TRUEHD", "A_MLP"]);

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

/**
 * Construit une chaîne `dvh1.PP.LL` depuis l'enregistrement Dolby Vision du conteneur.
 *
 * Disposition, vérifiée contre ffprobe sur un vrai fichier de cette bibliothèque plutôt que lue
 * dans une spécification : deux octets de version, puis seize bits portant le profil sur sept
 * bits, le niveau sur six, et trois drapeaux — RPU, couche d'amélioration, couche de base.
 *
 *     01 00 10 35 …  →  version 1.0, profil 8, niveau 6, rpu=1 el=0 bl=1
 *
 * `dvh1` et non `dvhe` : les deux ne diffèrent que par l'endroit où vivent les jeux de paramètres,
 * et le remultiplexeur les écrit dans l'entrée d'échantillon — ce que `dvh1` désigne, exactement
 * comme `hvc1` le fait face à `hev1`.
 *
 * Les deux nombres sont sur deux chiffres, zéro devant compris : `dvh1.08.06`, jamais `dvh1.8.6`.
 * Aucun navigateur ne reconnaît la seconde forme.
 */
export interface DolbyVisionInfo {
  /** La chaîne à proposer au navigateur : `dvh1.PP.LL`. */
  codec: string;
  profile: number;
  level: number;
  /**
   * Ce que vaut la couche de base pour un lecteur qui ignore le Dolby Vision.
   *
   * `0` veut dire « rien » : la couche est en IPT-PQ, propriétaire, et la décoder comme du HDR10
   * donne des couleurs fausses — c'est le cas du profil 5, deux fichiers de cette bibliothèque.
   * `1` veut dire « c'est du HDR10 », et `2` « c'est du SDR » : dans les deux cas, un lecteur sans
   * Dolby Vision affiche quelque chose de juste. C'est ce chiffre, et lui seul, qui décide si un
   * refus du navigateur laisse une porte de sortie ou non.
   *
   * Relevé sur « Retour vers le futur II » : `01 00 10 35 10 …`, l'octet 4 portant `1` dans son
   * quartet haut — ce que ffprobe nomme `dv_bl_signal_compatibility_id=1`.
   */
  compatibilityId: number;
}

export function dolbyVisionInfo(record: Uint8Array): DolbyVisionInfo | null {
  if (record.length < 5) return null;
  const bits = (record[2] << 8) | record[3];
  const profile = (bits >> 9) & 0x7f;
  const level = (bits >> 3) & 0x3f;
  if (profile === 0 || level === 0) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    codec: `dvh1.${pad(profile)}.${pad(level)}`,
    profile,
    level,
    compatibilityId: (record[4] >> 4) & 0x0f,
  };
}

/** La seule chaîne, pour qui n'a pas besoin du reste. */
export function dolbyVisionCodecString(record: Uint8Array): string | null {
  return dolbyVisionInfo(record)?.codec ?? null;
}

/** Builds an `avc1.*` string from the avcC record: profile, compatibility and level. */
export function avcCodecString(avcC: Uint8Array): string | null {
  if (avcC.length < 4) return null;
  // Lower-case hex here, upper-case for HEVC: that split is what the codec-string conventions
  // actually use, and browsers are picky about the whole token matching.
  return `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`.toLowerCase();
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

/**
 * A block with no picture in it, split into the units that belong to the picture before it and
 * those that belong to the one after — or `null` when the block does carry a picture, or cannot
 * be read (the container's word stands when there is nothing to check it against).
 *
 * Matroska means one block per picture, and *Dirty Dancing* (21/09/2026) breaks that: before
 * three of its CRA keyframes sits a block holding VPS, SPS, PPS and a Dolby Vision RPU (NAL 62)
 * and no slice, timed as though it were a picture — at the same instant as a real one. The
 * picture just before it is the only one in the stream without an RPU: the muxer cut the access
 * unit boundary in the wrong place, and that RPU is its. Handed to Safari as a sample of its own,
 * the block closed the MediaSource at every keyframe it preceded, and a pipeline *starting* on
 * the keyframe never saw it — which is why each rebuild played until the next one. Glued whole
 * onto the next picture it is still wrong: an RPU is a suffix unit, and one ahead of a slice is
 * illegal.
 *
 * So the access units are put back together by the rule HEVC itself states (7.4.2.4.4): suffix
 * units — the RPU, suffix SEI, end of sequence — close the picture before; parameter sets and
 * prefix SEI open the picture after. H.264 has no suffix units that matter here, so everything
 * goes forward.
 */
export function strayUnits(
  data: Uint8Array,
  codecId: string,
  lengthSize: number
): { before: Uint8Array[]; after: Uint8Array[] } | null {
  const hevc = codecId === "V_MPEGH/ISO/HEVC";
  if (!hevc && codecId !== "V_MPEG4/ISO/AVC") return null;

  const before: Uint8Array[] = [];
  const after: Uint8Array[] = [];
  for (let at = 0; at + lengthSize + 1 <= data.byteLength; ) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + data[at + i];
    if (length <= 0 || at + lengthSize + length > data.byteLength) return null;
    const header = data[at + lengthSize];
    // Kept with its length prefix, so a unit is moved as the bytes a sample already holds.
    const unit = data.subarray(at, at + lengthSize + length);
    if (hevc) {
      const type = (header >> 1) & 0x3f;
      if (type <= 31) return null; // a slice: this block is a picture
      const suffix = type === 36 || type === 37 || type === 38 || type === 40 || (type >= 45 && type <= 47) || type >= 56;
      (suffix ? before : after).push(unit);
    } else {
      const type = header & 0x1f;
      if (type >= 1 && type <= 5) return null;
      after.push(unit);
    }
    at += lengthSize + length;
  }
  return before.length + after.length > 0 ? { before, after } : null;
}

/**
 * Une image HEVC dont les messages SEI de lumière sont plafonnés à `capNits` : `content light
 * level` (144, MaxCLL et MaxFALL) et `mastering display colour volume` (137, luminance maximale).
 * Le reste de l'image est rendu tel quel ; sans rien à plafonner, l'image elle-même, sans copie.
 *
 * Pourquoi : Chrome sous Windows ramène tout le film sous la lumière maximale qu'il annonce. Un
 * film annoncé à 4 000 nits devient très sombre sur un écran qui n'affiche pas le HDR — *2012*,
 * *Apocalypse Now* —, quand Firefox le montre juste ; un film annoncé à 657 nits (*Dirty
 * Dancing*) s'y affiche bien (22/09/2026). Chrome lit ces valeurs dans le flux, pas seulement
 * dans le conteneur : les réécrire ici est le seul moyen qu'il en tienne compte. Voir
 * `hdrLuminanceCap` pour le moment où on le fait.
 *
 * Les messages sont relus et réécrits sur la charge utile désembrouillée (octets d'échappement
 * 0x000003 retirés puis remis) : une valeur changée en place pourrait sinon créer ou détruire un
 * motif d'échappement et corrompre l'unité.
 */
export function withCappedLightLevels(data: Uint8Array, lengthSize: number, capNits: number): Uint8Array {
  const kept: Uint8Array[] = [];
  let changed = false;
  for (let at = 0; at + lengthSize + 2 <= data.byteLength; ) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + data[at + i];
    if (length <= 0 || at + lengthSize + length > data.byteLength) return data;
    const unit = data.subarray(at, at + lengthSize + length);
    at += lengthSize + length;
    const type = (unit[lengthSize] >> 1) & 0x3f;
    if (type === 39) {
      const capped = cappedSei(unit.subarray(lengthSize), capNits);
      if (capped) {
        const prefix = new Uint8Array(lengthSize);
        for (let i = 0, n = capped.length; i < lengthSize; i++) prefix[lengthSize - 1 - i] = (n >> (8 * i)) & 0xff;
        kept.push(prefix, capped);
        changed = true;
        continue;
      }
    }
    kept.push(unit);
  }
  return changed ? joinBytes(kept) : data;
}

/** L'unité SEI réécrite, ou `null` si elle ne porte rien à plafonner. */
function cappedSei(nal: Uint8Array, capNits: number): Uint8Array | null {
  const rbsp = unescapeRbsp(nal.subarray(2));
  let at = 0;
  let changed = false;
  while (at < rbsp.length && !(rbsp[at] === 0x80 && at === rbsp.length - 1)) {
    let type = 0;
    while (at < rbsp.length && rbsp[at] === 0xff) type += rbsp[at++];
    if (at >= rbsp.length) return null;
    type += rbsp[at++];
    let size = 0;
    while (at < rbsp.length && rbsp[at] === 0xff) size += rbsp[at++];
    if (at >= rbsp.length) return null;
    size += rbsp[at++];
    if (at + size > rbsp.length) return null;
    const view = new DataView(rbsp.buffer, rbsp.byteOffset + at, size);
    if (type === 144 && size >= 4) {
      for (const offset of [0, 2]) {
        if (view.getUint16(offset) > capNits) {
          view.setUint16(offset, capNits);
          changed = true;
        }
      }
    } else if (type === 137 && size >= 24) {
      // Luminance maximale en 0,0001 cd/m², après six primaires et le point blanc (seize octets).
      if (view.getUint32(16) > capNits * 10000) {
        view.setUint32(16, capNits * 10000);
        changed = true;
      }
    }
    at += size;
  }
  if (!changed) return null;
  return joinBytes([nal.subarray(0, 2), escapeRbsp(rbsp)]);
}

/** Retire les octets d'échappement (0x00 0x00 0x03 → 0x00 0x00). Toujours une copie. */
function unescapeRbsp(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    out[n++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

/** Remet les octets d'échappement là où la norme les exige (deux zéros suivis de 0 à 3). */
function escapeRbsp(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte <= 0x03) {
      out.push(0x03);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

/** Joins byte runs into one. */
export function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * The codec string for an AV1 track, from the configuration record Matroska already holds.
 *
 * `av01.P.LLT.DD` — profile, level, tier and bit depth. The specification allows a longer form
 * naming the colour description as well; the short one is what it calls the minimum and what
 * every player is required to understand, and saying less about colour is safer than saying it
 * wrongly, since the stream carries its own description regardless.
 *
 * Returns null for a record too short to read, so an unreadable one refuses the path rather than
 * producing a string that describes nothing.
 *
 * The bit depth is read rather than assumed. It used to be written as `.08` whatever the stream
 * was, which on the one ten-bit AV1 file here described it to a decoder as eight — a claim the
 * browser is entitled to act on.
 */
export function av1CodecString(av1C: Uint8Array): string | null {
  // marker and version, then profile and level, then tier and the bit-depth flags. Three bytes
  // is all that is read, so three is all that is required.
  if (av1C.length < 3 || (av1C[0] & 0x7f) !== 1) return null;

  const profile = (av1C[1] >> 5) & 0x07;
  const level = av1C[1] & 0x1f;
  const tier = (av1C[2] >> 7) & 0x01 ? "H" : "M";
  const highBitDepth = (av1C[2] >> 6) & 0x01;
  const twelveBit = (av1C[2] >> 5) & 0x01;
  // Profile 2 is the only one that can be twelve-bit; elsewhere the flag means ten.
  const depth = twelveBit && profile === 2 ? 12 : highBitDepth ? 10 : 8;

  return `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`;
}
