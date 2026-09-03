// The boxes that tell a player how to decode the bytes that follow.
//
// Video is nearly free here: Matroska stores HEVC and AVC exactly the way MP4 wants them — NAL
// units prefixed by their length, described by an hvcC or avcC record — and that record is
// literally the track's CodecPrivate. It is copied verbatim, not rebuilt.
//
// Audio is where the work is. AAC needs its configuration wrapped in the MPEG-4 descriptor
// hierarchy, and AC-3 and E-AC-3 need a description that does not exist anywhere in the Matroska
// file: it has to be read out of the first audio frame's own bitstream header. That is 71% of
// this library, so it is not optional.

import { box, concat, fourcc, fullBox, u16, u32, u8, zeros } from "./mp4Boxes";

/** Reads big-endian bit fields, which is how every audio bitstream header is defined. */
class BitReader {
  private bitPosition = 0;
  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.bitPosition >> 3] ?? 0;
      const bit = (byte >> (7 - (this.bitPosition & 7))) & 1;
      value = (value << 1) | bit;
      this.bitPosition += 1;
    }
    return value;
  }

  skip(count: number): void {
    this.bitPosition += count;
  }
}

/** Writes big-endian bit fields, for the description boxes that are defined the same way. */
class BitWriter {
  private bits: number[] = [];

  write(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
    return this;
  }

  bytes(): Uint8Array {
    // Padded to a byte boundary, as every one of these boxes is.
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    }
    return out;
  }
}

// ── Video ────────────────────────────────────────────────────────────────────

/** The fields every visual sample entry starts with, before its codec-specific box. */
function visualSampleEntry(type: string, width: number, height: number, configuration: Uint8Array): Uint8Array {
  return box(
    type,
    zeros(6), // reserved
    u16(1), // data reference index
    u16(0), u16(0), // pre-defined, reserved
    zeros(12), // pre-defined
    u16(width),
    u16(height),
    u32(0x00480000), // 72 dpi horizontal
    u32(0x00480000), // 72 dpi vertical
    u32(0), // reserved
    u16(1), // frame count
    zeros(32), // compressor name, a fixed 32-byte field left empty
    u16(0x0018), // depth: colour with no alpha
    u16(0xffff), // pre-defined
    configuration
  );
}

export function videoSampleEntry(codecId: string, codecPrivate: Uint8Array, width: number, height: number): Uint8Array {
  switch (codecId) {
    case "V_MPEGH/ISO/HEVC":
      // hvc1: parameter sets live in this box rather than in the stream, which is what Matroska
      // already stores and what MP4 expects.
      return visualSampleEntry("hvc1", width, height, box("hvcC", codecPrivate));
    case "V_MPEG4/ISO/AVC":
      return visualSampleEntry("avc1", width, height, box("avcC", codecPrivate));
    default:
      throw new Error(`Codec vidéo non remultiplexable : ${codecId}`);
  }
}

// ── Audio ────────────────────────────────────────────────────────────────────

function audioSampleEntry(type: string, channels: number, sampleRate: number, configuration: Uint8Array): Uint8Array {
  return box(
    type,
    zeros(6), // reserved
    u16(1), // data reference index
    u32(0), u32(0), // reserved
    u16(channels),
    u16(16), // sample size, fixed at 16 in this field regardless of the real depth
    u16(0), u16(0), // pre-defined, reserved
    // 16.16 fixed point, and it cannot express rates above 65535 — those are carried by the
    // codec's own configuration instead, which is where a player reads them from anyway.
    u32(Math.min(sampleRate, 65535) << 16),
    configuration
  );
}

/** MPEG-4 descriptors are tag, length (7 bits per byte), then payload. */
function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  const length: number[] = [];
  let remaining = payload.length;
  do {
    length.unshift(remaining & 0x7f);
    remaining >>= 7;
  } while (remaining > 0);
  for (let i = 0; i < length.length - 1; i++) length[i] |= 0x80;
  return concat(u8(tag), new Uint8Array(length), payload);
}

/** AAC: its AudioSpecificConfig wrapped in the descriptor hierarchy MP4 requires. */
function esds(audioSpecificConfig: Uint8Array): Uint8Array {
  const decoderSpecific = descriptor(0x05, audioSpecificConfig);
  const decoderConfig = descriptor(
    0x04,
    concat(
      u8(0x40), // MPEG-4 audio
      u8(0x15), // audio stream
      new Uint8Array([0, 0, 0]), // buffer size, left unspecified
      u32(0), // max bitrate, unspecified
      u32(0), // average bitrate, unspecified
      decoderSpecific
    )
  );
  const slConfig = descriptor(0x06, u8(0x02));
  const es = descriptor(0x03, concat(u16(0), u8(0), decoderConfig, slConfig));
  return fullBox("esds", 0, 0, es);
}

const AC3_SAMPLE_RATES = [48000, 44100, 32000];

/**
 * The AC-3 description, read from the first frame's own header — none of it exists in the
 * Matroska file. Layout per ETSI TS 102 366: sync word, CRC, then the fields below.
 */
export function dac3(frame: Uint8Array): Uint8Array {
  const reader = new BitReader(frame);
  if (reader.read(16) !== 0x0b77) throw new Error("Trame AC-3 sans mot de synchronisation.");
  reader.skip(16); // crc1
  const fscod = reader.read(2);
  const frmsizecod = reader.read(6);
  const bsid = reader.read(5);
  const bsmod = reader.read(3);
  const acmod = reader.read(3);
  // Mix level fields are present or absent depending on the channel configuration; skipping the
  // wrong number of bits here silently shifts everything after it.
  if ((acmod & 0x01) !== 0 && acmod !== 0x01) reader.skip(2); // centre mix level
  if ((acmod & 0x04) !== 0) reader.skip(2); // surround mix level
  if (acmod === 0x02) reader.skip(2); // Dolby surround mode
  const lfeon = reader.read(1);

  return box(
    "dac3",
    new BitWriter()
      .write(fscod, 2)
      .write(bsid, 5)
      .write(bsmod, 3)
      .write(acmod, 3)
      .write(lfeon, 1)
      .write(frmsizecod >> 1, 5) // bit rate code
      .write(0, 5) // reserved
      .bytes()
  );
}

/**
 * The E-AC-3 description. Only the first independent substream is described, which is what a
 * stereo or 5.1 track is; dependent substreams carry the extra channels of an Atmos mix and a
 * player that cannot use them ignores them anyway.
 */
export function dec3(frame: Uint8Array): Uint8Array {
  const reader = new BitReader(frame);
  if (reader.read(16) !== 0x0b77) throw new Error("Trame E-AC-3 sans mot de synchronisation.");
  reader.skip(2); // stream type
  reader.skip(3); // substream id
  const frmsiz = reader.read(11);
  const fscod = reader.read(2);
  // At the lowest sample rates the field is reused to select a half rate, and the block count is
  // then fixed at six rather than being coded.
  const numblkscod = fscod === 3 ? 3 : reader.read(2);
  const acmod = reader.read(3);
  const lfeon = reader.read(1);
  const bsid = reader.read(5);

  const sampleRate = fscod === 3 ? AC3_SAMPLE_RATES[reader.read(2)] / 2 : AC3_SAMPLE_RATES[fscod];
  const blocks = [1, 2, 3, 6][numblkscod];
  const frameBytes = (frmsiz + 1) * 2;
  // The box wants a rate in kbit/s, which the frame size and its duration give directly.
  const dataRate = Math.round((frameBytes * 8 * sampleRate) / (blocks * 256) / 1000);

  return box(
    "dec3",
    new BitWriter()
      .write(Math.min(dataRate, 0x1fff), 13)
      .write(0, 3) // one independent substream, coded as count minus one
      .write(fscod, 2)
      .write(bsid, 5)
      .write(0, 1) // reserved
      .write(0, 1) // asvc
      .write(0, 3) // bsmod
      .write(acmod, 3)
      .write(lfeon, 1)
      .write(0, 3) // reserved
      .write(0, 4) // no dependent substreams described
      .write(0, 1) // reserved, in place of the channel location field
      .bytes()
  );
}

export interface AudioEntryInput {
  codecId: string;
  codecPrivate: Uint8Array | null;
  channels: number;
  sampleRate: number;
  /** The first frame of the track — the only place an AC-3 description can be read from. */
  firstFrame: Uint8Array | null;
}

/** The sampling frequencies an AudioSpecificConfig can name by index, in order. */
const ASC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export interface AacConfig {
  /** The AAC object type: 2 is LC, 5 is HE (SBR), 29 is HE v2 (SBR + parametric stereo). */
  objectType: number;
  /** The rate the decoder outputs — twice the core rate when SBR is signalled. */
  sampleRate: number;
  channels: number;
}

/**
 * Reads back what an AAC decoder configuration actually says.
 *
 * These bytes come from the browser's own encoder, and asking for one profile is not the same as
 * being given it: an encoder left to choose its own bitrate may answer with HE-AAC, whose config
 * declares a different object type, twice the sample rate and — for the v2 flavour — a different
 * channel count than the one it was handed. Writing `mp4a.40.2` over that produces an init
 * segment that contradicts itself, which Safari does not merely refuse: it tears down the whole
 * MediaSource, and every buffer on it becomes invalid.
 *
 * Returns null for anything it cannot read, so a description it does not understand is passed
 * through untouched rather than replaced with a guess.
 */
export function parseAacConfig(config: Uint8Array): AacConfig | null {
  if (config.length < 2) return null;
  const reader = new BitReader(config);

  const readObjectType = (): number => {
    const value = reader.read(5);
    // 31 is the escape: the real type is six more bits, offset by 32.
    return value === 31 ? 32 + reader.read(6) : value;
  };
  const readRate = (): number => {
    const index = reader.read(4);
    // 15 is the escape: the rate is written out in full rather than named by index.
    return index === 15 ? reader.read(24) : (ASC_SAMPLE_RATES[index] ?? 0);
  };

  let objectType = readObjectType();
  let sampleRate = readRate();
  let channels = reader.read(4);
  if (sampleRate === 0) return null;

  // Explicit hierarchical signalling: the core is described first, then the extension. The rate
  // that matters to a player is the extension's, and the object type is the extension's too.
  if (objectType === 5 || objectType === 29) {
    sampleRate = readRate();
    const core = readObjectType();
    // Parametric stereo turns one core channel into two on output.
    if (objectType === 29 && channels === 1) channels = 2;
    if (core === 22) reader.skip(4); // ER BSAC: a layer count sits here
  }

  return { objectType, sampleRate, channels };
}

export function audioSampleEntryFor(input: AudioEntryInput): Uint8Array {
  const { codecId, codecPrivate, channels, sampleRate, firstFrame } = input;
  switch (codecId) {
    case "A_AAC":
      if (!codecPrivate) throw new Error("Piste AAC sans configuration de décodeur.");
      return audioSampleEntry("mp4a", channels, sampleRate, esds(codecPrivate));
    case "A_AC3":
      if (!firstFrame) throw new Error("Piste AC-3 sans trame à analyser.");
      return audioSampleEntry("ac-3", channels, sampleRate, dac3(firstFrame));
    case "A_EAC3":
      if (!firstFrame) throw new Error("Piste E-AC-3 sans trame à analyser.");
      return audioSampleEntry("ec-3", channels, sampleRate, dec3(firstFrame));
    default:
      throw new Error(`Codec audio non remultiplexable : ${codecId}`);
  }
}

export const __testing = { BitReader, BitWriter, descriptor, esds };
