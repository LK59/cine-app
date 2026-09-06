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
    case "V_AV1":
      // The easiest of the three: Matroska keeps an AV1 track's configuration as the very box an
      // MP4 wants, so it is carried across untouched rather than parsed and rebuilt.
      return visualSampleEntry("av01", width, height, box("av1C", codecPrivate));
    default:
      throw new Error(`Codec vidéo non remultiplexable : ${codecId}`);
  }
}

// ── Audio ────────────────────────────────────────────────────────────────────

/**
 * @param sampleSize Bits per sample to declare. Sixteen is the conventional value and every codec
 *   here is content with it — except FLAC, whose mapping requires this field to *equal* the depth
 *   in its own STREAMINFO, and whose readers check. See {@link flacBitsPerSample}.
 */
function audioSampleEntry(
  type: string,
  channels: number,
  sampleRate: number,
  configuration: Uint8Array,
  sampleSize = 16
): Uint8Array {
  return box(
    type,
    zeros(6), // reserved
    u16(1), // data reference index
    u32(0), u32(0), // reserved
    u16(channels),
    u16(sampleSize),
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
  // Zero is "null object type" — not a profile a browser could ever have produced, and the sign
  // that these bytes are something other than the configuration they were taken for.
  if (objectType === 0 || sampleRate === 0) return null;

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

/**
 * Digs the AudioSpecificConfig out of whatever the browser handed back.
 *
 * `decoderConfig.description` is specified as the bare config, and Chrome gives exactly that.
 * Safari gives the whole `esds` payload — the descriptor tree, with the config buried three
 * levels down. Wrapping that in another `esds` produces a box describing a description, which is
 * why the codec string came out as `mp4a.40.0`: the first five bits being read were the leading
 * descriptor tag, not an object type.
 *
 * Returns null when the bytes are not a descriptor tree, so a bare config is left alone.
 */
export function extractAudioSpecificConfig(bytes: Uint8Array): Uint8Array | null {
  let position = 0;

  /** Descriptor lengths are base-128, seven bits per byte, high bit meaning "another follows". */
  const readLength = (): number => {
    let length = 0;
    for (let i = 0; i < 4 && position < bytes.length; i++) {
      const byte = bytes[position++];
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return length;
  };

  const walk = (end: number): Uint8Array | null => {
    while (position + 2 <= end) {
      const tag = bytes[position++];
      const length = readLength();
      const payloadEnd = Math.min(position + length, end);
      if (payloadEnd > bytes.length) return null;

      switch (tag) {
        case 0x05: // DecoderSpecificInfo — the configuration itself
          return bytes.subarray(position, payloadEnd);
        case 0x03: // ES_Descriptor: an id, a flags byte, then children
          position += 3;
          return walk(payloadEnd);
        case 0x04: // DecoderConfigDescriptor: thirteen fixed bytes, then children
          position += 13;
          return walk(payloadEnd);
        default:
          position = payloadEnd;
      }
    }
    return null;
  };

  // Only a tree that starts where one is expected. Anything else is left as it came.
  if (bytes.length < 4 || (bytes[0] !== 0x03 && bytes[0] !== 0x04 && bytes[0] !== 0x05)) return null;
  return walk(bytes.length);
}

/**
 * Opus: the identification header the encoder hands back, rewritten as an `OpusSpecificBox`.
 *
 * The two carry the same fields and disagree on almost everything else. The header is Ogg's — it
 * opens with the magic "OpusHead", a version byte, and stores its multi-byte numbers
 * little-endian. The box has neither magic nor that version, and MP4 is big-endian throughout.
 * Copying one into the other, which is the obvious thing to try, produces a channel count read
 * from the version byte and a sample rate off by several orders of magnitude.
 */
export function dOps(opusHead: Uint8Array): Uint8Array {
  if (opusHead.length < 19) throw new Error("En-tête Opus trop court.");
  const view = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
  const channels = opusHead[9];
  const preSkip = view.getUint16(10, true);
  const inputRate = view.getUint32(12, true);
  const outputGain = view.getInt16(16, true);
  const mappingFamily = opusHead[18];

  const head = concat(
    u8(0), // version of the box, which is not the version in the header
    u8(channels),
    u16(preSkip),
    u32(inputRate),
    u16(outputGain & 0xffff),
    u8(mappingFamily)
  );
  // Family 0 is mono or plain stereo and carries no table; anything else names its streams.
  const table = mappingFamily === 0 ? new Uint8Array(0) : opusHead.subarray(19, 19 + 2 + channels);
  return box("dOps", head, table);
}

export function opusSampleEntry(opusHead: Uint8Array, channels: number, sampleRate: number): Uint8Array {
  return audioSampleEntry("Opus", channels, sampleRate, dOps(opusHead));
}

/**
 * FLAC: the STREAMINFO block, lifted out of what Matroska keeps as the codec's private data.
 *
 * Matroska stores a FLAC track's configuration as the file's own header — the four magic bytes
 * `fLaC` followed by the metadata blocks — while MP4 wants a `dfLa` box holding those same blocks
 * without the magic. So the magic is dropped and the rest is carried across as it is; a
 * decoder needs STREAMINFO and is content to ignore the seek tables and comments beside it.
 *
 * Returns null when the bytes are not a FLAC header, rather than producing a box describing
 * nothing.
 */
function flacBlocks(codecPrivate: Uint8Array): Uint8Array | null {
  const hasMagic =
    codecPrivate.length > 8 &&
    codecPrivate[0] === 0x66 && codecPrivate[1] === 0x4c && codecPrivate[2] === 0x61 && codecPrivate[3] === 0x43;
  const blocks = hasMagic ? codecPrivate.subarray(4) : codecPrivate;
  // The first block must be STREAMINFO — type 0 in the low seven bits of its header byte — and
  // it is thirty-four bytes long, so anything shorter cannot describe a stream.
  if (blocks.length < 38 || (blocks[0] & 0x7f) !== 0) return null;
  return blocks;
}

export function dfLa(codecPrivate: Uint8Array): Uint8Array | null {
  const blocks = flacBlocks(codecPrivate);
  if (!blocks) return null;

  /**
   * STREAMINFO seul, et déclaré comme le dernier.
   *
   * Ce que Matroska garde ici est le début du fichier FLAC d'origine, et l'en-tête de bloc y porte
   * encore le drapeau « d'autres blocs suivent » — vérifié sur les fichiers de cette bibliothèque :
   * les six pistes examinées ont toutes `dernier=false`, et rien derrière. Recopié tel quel, notre
   * `dfLa` annonçait donc une chaîne qui continue au-delà de la fin de la boîte. Chrome ne s'en
   * plaint pas, parce qu'il ne lit que STREAMINFO — mais c'est exactement l'espèce de détail sur
   * lequel il nous a refusé un segment entier douze heures plus tôt, et rien ne dit que le
   * prochain lecteur sera aussi indulgent.
   *
   * On n'émet donc que les trente-huit octets qui décrivent le flux, drapeau corrigé. Ça vaut
   * aussi pour un fichier qui porterait davantage : une table de recherche ou une pochette n'aide
   * aucun décodeur et voyagerait dans chaque segment d'initialisation.
   */
  const streamInfo = blocks.slice(0, 38);
  streamInfo[0] |= 0x80;
  return box("dfLa", u32(0), streamInfo); // version and flags, then the blocks
}

/**
 * The depth STREAMINFO declares, which the sample entry beside it has to repeat.
 *
 * Chrome refuses the whole append otherwise, in as many words: « FLAC AudioSampleEntry sample size
 * mismatches FLACSpecificBox STREAMINFO sample size ». The field was written as a fixed sixteen —
 * correct for every other codec here, where nothing reads it — so a twenty-four-bit FLAC track
 * killed the MediaSource on the first init segment, before a single frame. Safari does not check,
 * which is why the same file played on an iPhone and not on an Android.
 *
 * STREAMINFO is a bit field, not a byte one. Sixteen bits of minimum block size, sixteen of
 * maximum, twenty-four of minimum frame size, twenty-four of maximum, twenty of sample rate, three
 * of channel count — one hundred and three bits before the five that matter, so they straddle the
 * boundary between the thirteenth and fourteenth bytes. Stored one less than the real value.
 */
export function flacBitsPerSample(codecPrivate: Uint8Array): number | null {
  const blocks = flacBlocks(codecPrivate);
  if (!blocks) return null;
  const info = blocks.subarray(4); // past this block's own four-byte header
  return (((info[12] & 0x01) << 4) | (info[13] >> 4)) + 1;
}

export function audioSampleEntryFor(input: AudioEntryInput): Uint8Array {
  const { codecId, codecPrivate, channels, sampleRate, firstFrame } = input;
  switch (codecId) {
    case "A_AAC":
      if (!codecPrivate) throw new Error("Piste AAC sans configuration de décodeur.");
      return audioSampleEntry("mp4a", channels, sampleRate, esds(codecPrivate));
    case "A_FLAC": {
      if (!codecPrivate) throw new Error("Piste FLAC sans configuration de décodeur.");
      const configuration = dfLa(codecPrivate);
      if (!configuration) throw new Error("Configuration FLAC illisible.");
      // La profondeur vient du fichier, jamais d'une valeur par défaut : c'est la seule des deux
      // que le lecteur compare à l'autre.
      return audioSampleEntry("fLaC", channels, sampleRate, configuration, flacBitsPerSample(codecPrivate) ?? 16);
    }
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
