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

import type { TrackColour } from "./matroska";
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

/**
 * Ce qu'il faut pour annoncer du Dolby Vision, quand on a de quoi le faire.
 *
 * L'entrée s'appelle `dvh1` au lieu de `hvc1` et porte **deux** boîtes : le `hvcC` habituel, qui
 * configure le décodeur HEVC, *et* l'enregistrement Dolby — `dvcC` ou `dvvC` selon la version du
 * format. Ce n'est pas un remplacement : un lecteur qui ne sait rien du Dolby Vision lit le
 * `hvcC` et décode la couche de base, ce qui est précisément ce qui rend le profil 8 sûr.
 *
 * L'enregistrement est **recopié tel quel**, jamais reconstruit. C'est la règle de CLAUDE.md sur
 * ce qui s'écrit dans une boîte MP4 — et ici elle est doublement vraie : ce que nous savons de ce
 * record, nous l'avons lu dans le conteneur, et un lecteur qui le comparerait à ce que porte le
 * flux trouverait exactement la même chose.
 */
function dolbyVisionSampleEntry(
  codecPrivate: Uint8Array,
  width: number,
  height: number,
  dolbyVision: { type: string; record: Uint8Array },
  colour: Uint8Array
): Uint8Array {
  return visualSampleEntry(
    "dvh1",
    width,
    height,
    concat(box("hvcC", codecPrivate), box(dolbyVision.type, dolbyVision.record), colour)
  );
}

/**
 * La description de l'image que tout MP4 bien construit porte, recopiée du conteneur : `colr`
 * (primaires, courbe de transfert, matrice, plage), `mdcv` (l'écran de mastering) et `clli` (la
 * lumière du contenu lui-même).
 *
 * Absentes jusqu'au 22/09/2026. Le navigateur n'avait que ce qu'il trouve dans le flux, et chacun
 * s'en arrangeait à sa façon : un épisode HDR10+ s'affichait nettement trop sombre dans Chrome
 * sous Windows — écran SDR ou HDR — quand Firefox et Safari le montraient juste. Une boîte n'est
 * écrite que si le fichier en donne toutes les valeurs ; rien n'est inventé (CLAUDE.md : ce qu'une
 * boîte porte vient du fichier, pas d'une constante).
 */
export function colourBoxes(colour: TrackColour | undefined): Uint8Array {
  if (!colour) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  const { primaries, transferCharacteristics: transfer, matrixCoefficients: matrix } = colour;
  // 2 veut dire « non précisé » dans les trois tables (ISO/IEC 23091-2) : pas de quoi écrire.
  if (primaries && transfer && matrix && primaries !== 2 && transfer !== 2 && matrix !== 2) {
    parts.push(box("colr", fourcc("nclx"), u16(primaries), u16(transfer), u16(matrix), u8(colour.range === 2 ? 0x80 : 0)));
  }
  const m = colour.masteringPrimaries;
  if (m && colour.masteringMaxNits && colour.masteringMinNits !== undefined) {
    // Ordre vert, bleu, rouge, en 0,00002 ; luminances en 0,0001 cd/m² — celui de la SEI HEVC.
    const xy = ([x, y]: [number, number]) => concat(u16(Math.round(x * 50000)), u16(Math.round(y * 50000)));
    parts.push(
      box(
        "mdcv",
        xy(m.g), xy(m.b), xy(m.r), xy(m.white),
        u32(Math.round(colour.masteringMaxNits * 10000)),
        u32(Math.round(colour.masteringMinNits * 10000))
      )
    );
  }
  if (colour.maxContentLightNits) {
    parts.push(box("clli", u16(Math.min(65535, colour.maxContentLightNits)), u16(Math.min(65535, colour.maxFrameAverageNits ?? 0))));
  }
  return parts.length ? concat(...parts) : new Uint8Array(0);
}

export function videoSampleEntry(
  codecId: string,
  codecPrivate: Uint8Array,
  width: number,
  height: number,
  /**
   * Fourni seulement quand on a décidé de livrer du Dolby Vision — c'est-à-dire quand le
   * conteneur porte l'enregistrement *et* que le navigateur a dit accepter la chaîne construite
   * depuis lui. Absent, rien ne change : l'entrée reste `hvc1`, comme depuis toujours.
   */
  dolbyVision?: { type: string; record: Uint8Array } | null,
  /** Voir `colourBoxes`. */
  colour?: TrackColour,
  /** Voir `SampleEntryOptions` : absent, l'entrée est celle d'avant à l'octet près. */
  options: SampleEntryOptions = {}
): Uint8Array {
  const described = colourBoxes(colour);
  switch (codecId) {
    case "V_MPEGH/ISO/HEVC":
      if (dolbyVision && options.signalling === "hls") {
        // Le HLS ne suit pas la décision MSE : la forme dépend du profil (`hlsDolbyVisionEntry`).
        // `hvc1+dv` ne diffère de `dvh1` que par le nom de l'entrée — mêmes boîtes, même ordre.
        const entry = hlsDolbyVisionEntry(dolbyVision.record);
        if (entry === "dvh1") return dolbyVisionSampleEntry(codecPrivate, width, height, dolbyVision, described);
        if (entry === "hvc1+dv") {
          return visualSampleEntry("hvc1", width, height, concat(box("hvcC", codecPrivate), box(dolbyVision.type, dolbyVision.record), described));
        }
        return visualSampleEntry("hvc1", width, height, concat(box("hvcC", codecPrivate), described));
      }
      if (dolbyVision) return dolbyVisionSampleEntry(codecPrivate, width, height, dolbyVision, described);
      // hvc1: parameter sets live in this box rather than in the stream, which is what Matroska
      // already stores and what MP4 expects.
      return visualSampleEntry("hvc1", width, height, concat(box("hvcC", codecPrivate), described));
    case "V_MPEG4/ISO/AVC":
      return visualSampleEntry("avc1", width, height, concat(box("avcC", codecPrivate), described));
    case "V_AV1":
      // The easiest of the three: Matroska keeps an AV1 track's configuration as the very box an
      // MP4 wants, so it is carried across untouched rather than parsed and rebuilt.
      return visualSampleEntry("av01", width, height, concat(box("av1C", codecPrivate), described));
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
  // then fixed at six rather than being coded. The half-rate selector (fscod2) sits exactly where
  // numblkscod would: it was read after bsid instead, which shifted acmod, lfeon and bsid by two
  // bits on every 24/22.05/16 kHz stream (ETSI TS 102 366 E.1.2.2).
  const fscod2 = fscod === 3 ? reader.read(2) : null;
  const numblkscod = fscod === 3 ? 3 : reader.read(2);
  const acmod = reader.read(3);
  const lfeon = reader.read(1);
  const bsid = reader.read(5);

  const sampleRate = fscod2 !== null ? AC3_SAMPLE_RATES[fscod2] / 2 : AC3_SAMPLE_RATES[fscod];
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

// ── Signalisation HLS (Lumen serveur) ───────────────────────────────────────
//
// Tout ce qui suit n'est lu que par le chemin HLS, et seulement quand l'appelant le demande
// (`SampleEntryOptions.signalling === "hls"`). `dec3()` et `dac3()` ci-dessus restent ce qu'ils
// étaient, octet pour octet : le chemin MediaSource ne passe jamais par ici.
//
// Pourquoi une description complète pour le HLS et pas pour MediaSource : en MSE, Safari décode ce
// qu'il reçoit et ne lit le `dec3` que pour savoir quoi ouvrir — un Atmos annoncé 5.1 joue en 5.1.
// En HLS, la liste maître dit `CHANNELS="16/JOC"` et Apple veut que ce nombre soit celui du
// `complexity_index_type_a` du `dec3` (HLS Authoring Specification, règle 2.8 et « Dolby Atmos ») :
// 681 pistes de la bibliothèque seraient sinon annoncées en 5.1, et les 25 E-AC-3 7.1 aussi.

/** Canaux par `acmod` (ETSI TS 102 366, tableau 4.3), sans le LFE. Même table que `mp4Demux.ts`. */
const ACMOD_CHANNEL_COUNT = [2, 1, 2, 3, 3, 4, 4, 5];

/**
 * Canaux ajoutés par chaque bit de `chan_loc`, **bit 0 = poids faible** (ETSI TS 102 366 V1.4.1,
 * tableau F.6.1 : « 8 (MSB) LFE2 ») : Lc/Rc, Lrs/Rrs, Cs, Ts, Lsd/Rsd, Lw/Rw, Lvh/Rvh, Cvh, LFE2.
 */
const CHAN_LOC_PAIRS = [2, 2, 1, 1, 2, 2, 2, 1, 1];

/** Ce qu'une suite de trames E-AC-3 dit d'elle-même — de quoi écrire un `dec3` complet. */
export interface Eac3IndependentSubstream {
  fscod: number;
  bsid: number;
  /** Lu dans `infomdate` ; 0 quand la trame ne le porte pas (F.6.2.8). */
  bsmod: number;
  acmod: number;
  lfeon: number;
  /** Nombre de sous-flux dépendants rattachés à celui-ci (0 à 8). */
  numDepSub: number;
  /** Les emplacements que ces dépendants ajoutent (tableau F.6.1), bit 0 = poids faible. */
  chanLoc: number;
}

export interface Eac3Description {
  /** kbit/s, somme de tous les sous-flux de la trame (F.6.2.2), bornée aux 13 bits du champ. */
  dataRate: number;
  substreams: Eac3IndependentSubstream[];
  /**
   * L'extension Atmos (JOC) du premier sous-flux indépendant, ou null. Lue dans `addbsi` : c'est
   * là que la norme la place (ETSI TS 103 420 V1.2.1 §8.3), et là que FFmpeg
   * (`libavcodec/ac3_parser.c`, `eac3_parse_header`) et GPAC (`av_parsers.c`,
   * `gf_eac3_parser_bs`) la lisent. Dolby : la valeur du `dec3` « doit égaler » celle de `addbsi`.
   */
  joc: { complexityIndex: number } | null;
  /** Canaux du programme principal : `acmod` + LFE + ceux que `chan_loc` ajoute. */
  channels: number;
}

/** Une trame E-AC-3 lue jusqu'au bout de `bsi()` — seulement les champs dont le `dec3` a besoin. */
interface Eac3Syncframe {
  strmtyp: number;
  substreamid: number;
  frameBytes: number;
  fscod: number;
  sampleRate: number;
  blocks: number;
  acmod: number;
  lfeon: number;
  bsid: number;
  bsmod: number;
  chanmap: number | null;
  joc: { complexityIndex: number } | null;
}

/**
 * Lit `bsi()` d'une trame E-AC-3 (ETSI TS 102 366 V1.4.1, E.1.2.2), champ par champ.
 *
 * Il faut tout traverser pour atteindre `addbsi`, le dernier champ : chaque condition ici est une
 * ligne du tableau de syntaxe, et en sauter une décale tout ce qui suit sans erreur visible. Les
 * mêmes conditions que FFmpeg (`eac3_parse_header`) et GPAC, relus côte à côte le 16/11/2026 ; seule
 * différence voulue : `mixdef == 3` saute `(mixdeflen + 2) × 8` bits d'un bloc, comme les deux, au
 * lieu de détailler `mixdata2e`/`mixdata3e` que ce bloc contient (leur longueur est comprise).
 */
function readEac3Syncframe(bytes: Uint8Array): Eac3Syncframe | null {
  if (bytes.length < 6) return null;
  // `bsid` tombe au même bit dans les deux syntaxes (40e), précisément pour qu'on puisse choisir
  // avant de lire. Une piste « E-AC-3 7.1 » de Blu-ray commence par une trame **AC-3** (bsid 6 ou
  // 8 : le cœur 5.1 que lit tout décodeur AC-3) suivie d'un dépendant E-AC-3 : *2 Guns*, *Edge of
  // Tomorrow*, *Saving Private Ryan* (16/11/2026). FFmpeg l'admet (`handle_eac3` : « AC-3
  // substream must be the first one »), la norme aussi (E.1.3.1.2).
  if (bytes[5] >> 3 <= 10) return readAc3AsSubstream(bytes);
  const r = new BitReader(bytes);
  if (r.read(16) !== 0x0b77) return null;
  const strmtyp = r.read(2);
  const substreamid = r.read(3);
  const frmsiz = r.read(11);
  const fscod = r.read(2);
  // fscod 3 : demi-fréquence dans fscod2, à la place de numblkscod, et toujours six blocs (E.1.3.1.5).
  const fscod2 = fscod === 3 ? r.read(2) : null;
  const numblkscod = fscod === 3 ? 3 : r.read(2);
  const acmod = r.read(3);
  const lfeon = r.read(1);
  const bsid = r.read(5);
  // Une trame AC-3 (bsid ≤ 10) n'a pas cette syntaxe : rien de ce qui suit n'aurait de sens.
  if (bsid <= 10 || bsid > 16 || strmtyp === 3) return null;
  const sampleRate = fscod2 !== null ? (AC3_SAMPLE_RATES[fscod2] ?? 0) / 2 : AC3_SAMPLE_RATES[fscod];
  if (!sampleRate) return null;
  const blocks = [1, 2, 3, 6][numblkscod];

  // dialnorm, compre/compr — deux fois en 1+1 (acmod 0).
  for (let i = 0; i < (acmod === 0 ? 2 : 1); i++) {
    r.skip(5);
    if (r.read(1)) r.skip(8);
  }
  let chanmap: number | null = null;
  if (strmtyp === 1 && r.read(1)) chanmap = r.read(16);
  if (r.read(1)) {
    // mixmdate
    if (acmod > 2) r.skip(2); // dmixmod
    if (acmod & 1 && acmod > 2) r.skip(6); // ltrtcmixlev, lorocmixlev
    if (acmod & 4) r.skip(6); // ltrtsurmixlev, lorosurmixlev
    if (lfeon && r.read(1)) r.skip(5); // lfemixlevcod
    if (strmtyp === 0) {
      if (r.read(1)) r.skip(6); // pgmscl
      if (acmod === 0 && r.read(1)) r.skip(6); // pgmscl2
      if (r.read(1)) r.skip(6); // extpgmscl
      const mixdef = r.read(2);
      if (mixdef === 1) r.skip(5);
      else if (mixdef === 2) r.skip(12);
      else if (mixdef === 3) r.skip((r.read(5) + 2) * 8);
      if (acmod < 2) {
        if (r.read(1)) r.skip(14); // panmean, paninfo
        if (acmod === 0 && r.read(1)) r.skip(14);
      }
      if (r.read(1)) {
        // frmmixcfginfoe : un seul champ pour une trame d'un bloc, sinon un par bloc.
        if (numblkscod === 0) r.skip(5);
        else for (let b = 0; b < blocks; b++) if (r.read(1)) r.skip(5);
      }
    }
  }
  let bsmod = 0;
  if (r.read(1)) {
    // infomdate
    bsmod = r.read(3);
    r.skip(2); // copyrightb, origbs
    if (acmod === 2) r.skip(4); // dsurmod, dheadphonmod
    if (acmod >= 6) r.skip(2); // dsurexmod
    if (r.read(1)) r.skip(8); // audprodie
    if (acmod === 0 && r.read(1)) r.skip(8); // audprodi2e
    if (fscod < 3) r.skip(1); // sourcefscod
  }
  if (strmtyp === 0 && numblkscod !== 3) r.skip(1); // convsync
  if (strmtyp === 2 && (numblkscod === 3 || r.read(1))) r.skip(6); // frmsizecod d'origine
  let joc: { complexityIndex: number } | null = null;
  if (r.read(1)) {
    // addbsie : addbsil + 1 octets. Le premier : 7 bits réservés puis flag_ec3_extension_type_a ;
    // le second, s'il existe, complexity_index_type_a (TS 103 420 §8.3). Un drapeau sans son
    // second octet ne dit pas le nombre à annoncer : pas d'extension plutôt qu'une valeur inventée
    // (GPAC exige aussi les deux octets ; FFmpeg lirait l'octet d'après, hors de `addbsi`).
    const length = r.read(6) + 1;
    r.skip(7);
    const flag = r.read(1);
    if (flag && length >= 2) {
      const complexityIndex = r.read(8);
      if (complexityIndex > 0) joc = { complexityIndex };
    }
  }
  return { strmtyp, substreamid, frameBytes: (frmsiz + 1) * 2, fscod, sampleRate, blocks, acmod, lfeon, bsid, bsmod, chanmap, joc };
}

/** Débit nominal (kbit/s) par `frmsizecod >> 1` (ETSI TS 102 366, tableau 4.13). */
const AC3_BIT_RATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];

/**
 * Une trame AC-3 lue comme le sous-flux indépendant 0 d'un flux E-AC-3 : ce que le `dec3` en dit
 * (F.6.2.4 à F.6.2.10 : « la même valeur que dans le flux indépendant ») et sa longueur, tirée du
 * tableau 4.13 — une trame AC-3 ne porte pas `frmsiz`.
 */
function readAc3AsSubstream(bytes: Uint8Array): Eac3Syncframe | null {
  const r = new BitReader(bytes);
  if (r.read(16) !== 0x0b77) return null;
  r.skip(16); // crc1
  const fscod = r.read(2);
  const frmsizecod = r.read(6);
  const bsid = r.read(5);
  const bsmod = r.read(3);
  const acmod = r.read(3);
  if ((acmod & 0x01) !== 0 && acmod !== 0x01) r.skip(2);
  if ((acmod & 0x04) !== 0) r.skip(2);
  if (acmod === 0x02) r.skip(2);
  const lfeon = r.read(1);
  const kbps = AC3_BIT_RATES[frmsizecod >> 1];
  const baseRate = AC3_SAMPLE_RATES[fscod];
  if (!kbps || !baseRate) return null;
  // Mots de 16 bits par trame de 1 536 échantillons ; à 44,1 kHz, un mot de plus pour un code impair.
  const words = fscod === 1 ? Math.floor((kbps * 1000 * 1536) / 44100 / 16) + (frmsizecod & 1) : (kbps * 1000 * 1536) / baseRate / 16;
  // bsid 9 et 10 : demi et quart de fréquence (FFmpeg, `sr_shift`).
  const sampleRate = baseRate >> Math.max(0, bsid - 8);
  return { strmtyp: 0, substreamid: 0, frameBytes: words * 2, fscod, sampleRate, blocks: 6, acmod, lfeon, bsid, bsmod, chanmap: null, joc: null };
}

/**
 * `chanmap` (16 bits, bit 0 = poids **fort**, tableau E.1.4) vers `chan_loc` (9 bits, bit 0 = poids
 * **faible**, tableau F.6.1). Les emplacements 5 à 12 de l'un sont les bits 0 à 7 de l'autre ;
 * Lts/Rts (13) n'a pas de place dans `chan_loc` ; LFE2 (14) en est le bit 8. Les cinq premiers
 * (L C R Ls Rs) et le LFE sont ceux du 5.1 : un dépendant qui les nomme les *remplace*, il n'ajoute
 * rien (F.6.2.13). C'est la table de FFmpeg (movenc.c, `handle_eac3`, corrigée en 2026 — la
 * version d'avant décalait de cinq bits et lisait un autre emplacement) et de GPAC
 * (`eac3_chanmap_to_chan_loc`).
 */
export function chanmapToChanLoc(chanmap: number): number {
  let chanLoc = 0;
  for (let j = 0; j < 8; j++) if ((chanmap >> (10 - j)) & 1) chanLoc |= 1 << j;
  if ((chanmap >> 1) & 1) chanLoc |= 1 << 8;
  return chanLoc;
}

/** Canaux ajoutés par un `chan_loc` (bit 0 = poids faible). */
export function chanLocChannels(chanLoc: number): number {
  let channels = 0;
  for (let i = 0; i < 9; i++) if (chanLoc & (1 << i)) channels += CHAN_LOC_PAIRS[i];
  return channels;
}

/**
 * Décrit une unité E-AC-3 — un bloc Matroska, qui porte la trame indépendante *et* ses dépendantes
 * mises bout à bout (c'est ce que FFmpeg reconstitue aussi avant d'écrire son `dec3`).
 *
 * Seule la première série est lue : une trame indépendante de `substreamid` 0 déjà vue ouvre la
 * suivante (F.6.2.3, note). Le nombre de dépendants est leur **compte** — FFmpeg (`num_dep_sub++`)
 * et GPAC (`1 + substreamid`) font de même ; la lettre de F.6.2.12 (« la valeur de `substreamid` du
 * dernier dépendant ») donnerait 0 pour un seul dépendant et ferait disparaître `chan_loc`.
 */
export function describeEac3(accessUnit: Uint8Array): Eac3Description {
  const substreams: Eac3IndependentSubstream[] = [];
  let bitsPerSecond = 0;
  let joc: Eac3Description["joc"] = null;
  for (let at = 0; at + 6 <= accessUnit.length; ) {
    const frame = readEac3Syncframe(accessUnit.subarray(at));
    if (!frame) break;
    if (frame.strmtyp === 1) {
      // Un dépendant avant tout indépendant n'appartient à rien de décrit : ignoré.
      const parent = substreams[substreams.length - 1];
      if (parent) {
        parent.numDepSub = Math.min(8, parent.numDepSub + 1);
        // Sans `chanmap`, le dépendant suit l'`acmod` du programme : il remplace, n'ajoute rien.
        if (frame.chanmap !== null) parent.chanLoc |= chanmapToChanLoc(frame.chanmap);
      }
    } else {
      if (frame.substreamid === 0 && substreams.length > 0) break; // série suivante
      if (frame.substreamid !== substreams.length || substreams.length >= 8) break;
      substreams.push({
        fscod: frame.fscod,
        bsid: frame.bsid,
        bsmod: frame.bsmod,
        acmod: frame.acmod,
        lfeon: frame.lfeon,
        numDepSub: 0,
        chanLoc: 0,
      });
      if (substreams.length === 1) joc = frame.joc;
    }
    bitsPerSecond += (frame.frameBytes * 8 * frame.sampleRate) / (frame.blocks * 256);
    at += frame.frameBytes;
  }
  const main = substreams[0];
  if (!main) throw new Error("Trame E-AC-3 illisible : aucun sous-flux indépendant.");
  return {
    dataRate: Math.min(Math.round(bitsPerSecond / 1000), 0x1fff),
    substreams,
    joc,
    channels: ACMOD_CHANNEL_COUNT[main.acmod] + main.lfeon + chanLocChannels(main.chanLoc),
  };
}

/**
 * Le `dec3` complet (ETSI TS 102 366 V1.4.1, F.6, et l'extension Dolby Atmos) : chaque sous-flux
 * indépendant, ses dépendants et leurs emplacements, puis — pour un Atmos — 7 bits réservés,
 * `flag_ec3_extension_type_a` et `complexity_index_type_a`. Disposition identique à `movenc.c`
 * (`mov_write_eac3_tag`), y compris l'extension écrite seulement quand elle existe.
 */
export function dec3Complete(description: Eac3Description): Uint8Array {
  const w = new BitWriter().write(description.dataRate, 13).write(description.substreams.length - 1, 3);
  for (const s of description.substreams) {
    w.write(s.fscod, 2)
      .write(s.bsid, 5)
      .write(0, 1) // réservé
      .write(0, 1) // asvc : service principal — FFmpeg et GPAC écrivent 0 aussi
      .write(s.bsmod, 3)
      .write(s.acmod, 3)
      .write(s.lfeon, 1)
      .write(0, 3) // réservé
      .write(s.numDepSub, 4);
    if (s.numDepSub > 0) w.write(s.chanLoc, 9);
    else w.write(0, 1); // réservé
  }
  if (description.joc) w.write(0, 7).write(1, 1).write(description.joc.complexityIndex, 8);
  return box("dec3", w.bytes());
}

/** Ce qu'une trame AC-3 dit de ses canaux — pour `CHANNELS` ; le `dac3` reste celui de `dac3()`. */
export function ac3Channels(frame: Uint8Array): number {
  const r = new BitReader(frame);
  if (r.read(16) !== 0x0b77) throw new Error("Trame AC-3 sans mot de synchronisation.");
  r.skip(16 + 2 + 6 + 5 + 3); // crc1, fscod, frmsizecod, bsid, bsmod
  const acmod = r.read(3);
  if ((acmod & 0x01) !== 0 && acmod !== 0x01) r.skip(2);
  if ((acmod & 0x04) !== 0) r.skip(2);
  if (acmod === 0x02) r.skip(2);
  return ACMOD_CHANNEL_COUNT[acmod] + r.read(1);
}

/**
 * Quelle entrée porte un enregistrement Dolby Vision dans une liste HLS (Apple, HLS Authoring
 * Specification, « Dolby Vision » et « Supplemental codecs ») :
 *
 * - **profil 8.1 / 8.2 / 8.4** (couche de base HDR10, SDR ou HLG) : `hvc1` + `hvcC` + la boîte DV.
 *   La liste dit `CODECS="hvc1…"` et `SUPPLEMENTAL-CODECS="dvh1.08.LL/db1p"` : un appareil sans
 *   Dolby Vision lit la base, un appareil DV lit le DV. Écrire `dvh1` ici contredirait `CODECS`.
 * - **profil 5** (IPT-PQ, aucune base lisible) : `dvh1`, comme MediaSource aujourd'hui.
 * - **tout le reste** (profil 7 à couche d'amélioration, que les appareils Apple ne lisent pas ; une
 *   compatibilité 8.x inconnue ; un enregistrement illisible) : `hvc1` sans boîte DV — on ne
 *   promet pas un Dolby Vision qu'aucun appareil ne saurait honorer.
 */
export type HlsDolbyVisionEntry = "hvc1+dv" | "dvh1" | "hvc1";

export function hlsDolbyVisionEntry(record: Uint8Array): HlsDolbyVisionEntry {
  if (record.length < 5) return "hvc1";
  const bits = (record[2] << 8) | record[3];
  const profile = (bits >> 9) & 0x7f;
  const level = (bits >> 3) & 0x3f;
  const compatibilityId = (record[4] >> 4) & 0x0f;
  if (level === 0) return "hvc1";
  if (profile === 5) return "dvh1";
  if (profile === 8 && (compatibilityId === 1 || compatibilityId === 2 || compatibilityId === 4)) return "hvc1+dv";
  return "hvc1";
}

/**
 * Les options d'écriture des entrées d'échantillon. Absentes — le cas de tout le lecteur actuel —,
 * rien ne change, à l'octet près. `signalling: "hls"` n'est passé que par le chemin Lumen serveur.
 */
export interface SampleEntryOptions {
  signalling?: "hls";
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
/**
 * Canaux par `channelConfiguration` (ISO/IEC 14496-3, 1.6.3.5, et 23003-3 pour 11 à 14). Zéro
 * veut dire « décrit ailleurs », et reste zéro.
 */
const AAC_CHANNEL_CONFIGURATIONS: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 8, 11: 7, 12: 8, 13: 24, 14: 8 };

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
  // Le champ nomme une *configuration*, pas un nombre de canaux : 7 est le 7.1, huit canaux. Lu
  // tel quel, l'encodeur 7.1 de l'iPhone (config 11 b8) était déclaré « 7 canaux » dans l'entrée
  // mp4a d'un flux qui en porte huit — relevé le 21/09/2026.
  const configuration = reader.read(4);
  let channels = AAC_CHANNEL_CONFIGURATIONS[configuration] ?? configuration;
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
 * L'en-tête d'identification Opus que Matroska garde comme `CodecPrivate` (« OpusHead », version
 * 1, au moins 19 octets, et la table de canaux complète quand la famille n'est pas 0) — ou faux.
 * Un en-tête qui ne se lit pas ainsi n'est pas copié : la piste garde son chemin d'avant.
 */
export function isOpusHead(bytes: Uint8Array | null | undefined): bytes is Uint8Array {
  if (!bytes || bytes.length < 19) return false;
  const magic = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // « OpusHead »
  if (!magic.every((b, i) => bytes[i] === b)) return false;
  if ((bytes[8] & 0xf0) !== 0) return false; // version 1 (0x01) ; les quatre bits hauts changent le format
  const channels = bytes[9];
  if (channels === 0) return false;
  const family = bytes[18];
  if (family === 0) return channels <= 2;
  return bytes.length >= 19 + 2 + channels;
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

export function audioSampleEntryFor(
  input: AudioEntryInput,
  /** Voir `SampleEntryOptions` : absent, l'entrée est celle d'avant à l'octet près. */
  options: SampleEntryOptions = {}
): Uint8Array {
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
      // En HLS, le `dec3` complet : sous-flux dépendants (7.1) et extension Atmos. `firstFrame` est
      // un bloc Matroska entier — la trame indépendante et ses dépendantes à la suite.
      if (options.signalling === "hls") return audioSampleEntry("ec-3", channels, sampleRate, dec3Complete(describeEac3(firstFrame)));
      return audioSampleEntry("ec-3", channels, sampleRate, dec3(firstFrame));
    case "A_OPUS": {
      // Copié tel quel (DECISIONS.md §66). Le nombre de canaux vient de l'en-tête Opus, comme celui
      // du `dOps` : les deux boîtes se comparent, et l'en-tête Matroska peut dire autre chose. La
      // fréquence est 48 000, toujours — celle de la boîte, quelle que soit la fréquence d'origine
      // (« Encapsulation of Opus in ISO Base Media File Format », entrée `Opus`).
      if (!isOpusHead(codecPrivate)) throw new Error("Configuration Opus illisible.");
      return opusSampleEntry(codecPrivate, codecPrivate[9], 48000);
    }
    default:
      throw new Error(`Codec audio non remultiplexable : ${codecId}`);
  }
}

export const __testing = { BitReader, BitWriter, descriptor, esds };
