// Lecture d'un fichier MP4 (ISO BMFF) pour le même pipeline que le Matroska.
//
// Jusqu'au 22/09/2026, un MP4 était remis tel quel à `<video>` (« lecture directe »), au motif
// qu'il était déjà l'emballage que le remultiplexeur fabrique. C'était vrai du conteneur, faux du
// reste — sur les quatorze MP4 de la bibliothèque : un E-AC3 muet sans un mot sur Chrome et
// Firefox (aucune erreur, donc aucun repli), un fichier de huit pistes audio et six sous-titres
// sans menu ni langue du compte, des sous-titres intégrés jamais affichés, un HEVC refusé qui
// finissait en écran d'erreur au lieu du lecteur serveur. Un bon conteneur ne dit pas que tout
// se lit nativement ; le traitement, lui, ne fait rien (ou presque) quand rien n'est à faire.
//
// Ce module décrit donc un MP4 dans la forme exacte d'un Matroska lu (`MatroskaFile`) : les mêmes
// pistes, les mêmes identifiants de codec (`V_MPEG4/ISO/AVC`, `A_EAC3`…), les mêmes enregistrements
// de configuration, un index de points d'accès. Tout ce qui est en aval — choix du chemin, choix
// de piste, transcodage, sous-titres, sauts, zone gardée, reconstructions — n'a pas à savoir d'où
// vient le fichier. Seul le lecteur d'échantillons diffère (`Mp4SampleReader`, plus bas).
//
// Ce qui n'est jamais lu : `mdat`. Les tables d'échantillons (`moov`) disent où est chaque
// échantillon, à l'octet près ; le reste se lit à la demande, par plages, comme les grappes d'un
// Matroska.

import type { ByteSource } from "./byteSource";
import type { CuePoint, MatroskaFile, MatroskaTrack, MediaSample, TrackColour } from "./matroska";
import { trace } from "./trace";

/**
 * Où vit chaque échantillon d'une piste, et quand il passe — le pendant, pour un MP4, des grappes
 * qu'un Matroska décrit lui-même au fil de la lecture.
 *
 * Des tableaux typés et rien d'autre : un film de trois heures porte ici 766 000 échantillons
 * (vidéo et son), soit ~25 octets chacun — une vingtaine de mégaoctets, là où un objet par
 * échantillon en coûterait dix fois plus.
 */
export interface Mp4TrackIndex {
  number: number;
  /** Décalage absolu dans le fichier. Float64 : un fichier dépasse volontiers 4 Go. */
  offsets: Float64Array;
  sizes: Uint32Array;
  /** Instant de décodage, en microsecondes, liste de montage appliquée. Croissant. */
  dtsUs: Float64Array;
  /** Présentation − décodage, en microsecondes. `null` : pas de réordonnancement (`ctts` absent). */
  ctsUs: Int32Array | null;
  /** 1 pour un échantillon de synchronisation. `null` : tous le sont (`stss` absent). */
  sync: Uint8Array | null;
  /** Durée du dernier échantillon, que rien d'autre ne donne. */
  lastDurationUs: number;
  /** mov_text : chaque échantillon commence par la longueur du texte, suivie de boîtes de style. */
  timedText: boolean;
}

export interface Mp4Index {
  tracks: Mp4TrackIndex[];
  /**
   * L'instant de décodage où reprendre la lecture pour chaque position d'index.
   *
   * Le lecteur d'échantillons ne parcourt pas le fichier dans l'ordre des octets mais dans celui
   * du temps (voir `Mp4SampleReader`), et un décalage seul ne dit pas où en est chaque piste. Les
   * positions données par l'index (`cues`) sont donc des clés : ce qu'on y retrouve est l'instant
   * de l'image clé qu'elles désignent.
   */
  starts: Map<number, number>;
}

/** Ce qui fait échouer un MP4 que ce lecteur ne sait pas lire — et part au lecteur serveur. */
export class Mp4Refusal extends Error {}

// ─── Lecture des boîtes ───────────────────────────────────────────────────────────────────────

interface Box {
  type: string;
  /** Début de la boîte (en-tête compris), relatif au tampon lu — ou absolu au niveau du fichier. */
  start: number;
  /** Début de son contenu. */
  body: number;
  end: number;
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv: DataView, at: number): number {
  return dv.getUint32(at) * 2 ** 32 + dv.getUint32(at + 4);
}

function i64(dv: DataView, at: number): number {
  return dv.getInt32(at) * 2 ** 32 + dv.getUint32(at + 4);
}

/** Les boîtes filles d'une plage d'un tampon en mémoire. S'arrête à la première qui déborde. */
function children(bytes: Uint8Array, from: number, to: number): Box[] {
  const dv = view(bytes);
  const boxes: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = dv.getUint32(at);
    const type = fourcc(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = u64(dv, at + 8);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    boxes.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

function child(bytes: Uint8Array, parent: Box, type: string): Box | undefined {
  return children(bytes, parent.body, parent.end).find((b) => b.type === type);
}

/** Le chemin `a/b/c` sous une boîte. */
function path(bytes: Uint8Array, parent: Box, ...types: string[]): Box | undefined {
  let current: Box | undefined = parent;
  for (const type of types) {
    if (!current) return undefined;
    current = child(bytes, current, type);
  }
  return current;
}

/**
 * Les boîtes de premier niveau, lues par leurs seuls en-têtes.
 *
 * `moov` peut être au début (fichier préparé pour le web) ou à la fin (fichier écrit d'un trait),
 * derrière un `mdat` de plusieurs gigaoctets qu'on enjambe sans le lire : une lecture de seize
 * octets par boîte, et la source a déjà demandé les deux bouts du fichier à l'ouverture.
 */
async function topLevel(source: ByteSource): Promise<Box[]> {
  const boxes: Box[] = [];
  let at = 0;
  // Un MP4 fragmenté enchaîne des milliers de paires moof/mdat : la première suffit à le savoir.
  for (let i = 0; i < 64 && at + 8 <= source.size; i++) {
    const head = await source.read(at, 16);
    if (head.length < 8) break;
    const dv = view(head);
    let size = dv.getUint32(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = u64(dv, 8);
      header = 16;
    } else if (size === 0) {
      size = source.size - at;
    }
    if (size < header) break;
    boxes.push({ type, start: at, body: at + header, end: Math.min(at + size, source.size) });
    if (type === "moof") break;
    at += size;
  }
  return boxes;
}

/** Les types de premier niveau qu'un fichier ISO peut porter en tête. */
const ISO_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "styp"]);

/**
 * Le fichier est-il un ISO BMFF (.mp4, .m4v, .mov) ? Lu sur ses octets, jamais sur son nom — un
 * nom se devine, les huit premiers octets non. Un QuickTime ancien peut commencer par `wide` ou
 * `mdat` sans `ftyp`.
 */
export function isIsoBaseMedia(head: Uint8Array): boolean {
  return head.length >= 8 && ISO_FIRST_BOXES.has(fourcc(head, 4));
}

// ─── Description des pistes ───────────────────────────────────────────────────────────────────

/**
 * Codes de langue Macintosh, pour les fichiers QuickTime qui en portent (valeur < 0x400 dans
 * `mdhd`). Les premiers seulement, comme les nomme FFmpeg — donc Jellyfin : lire autrement que
 * lui le même fichier, c'est précisément l'écart qui fait qu'une préférence de compte ne trouve
 * pas sa piste (voir la note sur la langue absente dans matroska.ts).
 */
const MAC_LANGUAGES = ["eng", "fre", "ger", "ita", "dut", "swe", "spa", "dan", "por", "nor", "heb", "jpn", "ara", "fin", "gre"];

/**
 * La langue d'une piste MP4 — `null` quand elle est inconnue.
 *
 * **Pas la règle du Matroska.** Là-bas, l'élément absent vaut « eng » par la spécification ; ici
 * le champ est toujours écrit, et `und` veut dire exactement ce qu'il dit : on ne sait pas. Six
 * des quatorze MP4 de la bibliothèque déclarent `und` sur leur son — et FFmpeg, donc Jellyfin,
 * les rapporte `und` aussi. Les deux lectures s'accordent, c'est ce qui compte.
 */
function mdhdLanguage(packed: number): string | null {
  if (packed < 0x400) return MAC_LANGUAGES[packed] ?? null;
  if (packed === 0x7fff) return null;
  const code = String.fromCharCode(((packed >> 10) & 0x1f) + 0x60, ((packed >> 5) & 0x1f) + 0x60, (packed & 0x1f) + 0x60);
  return /^[a-z]{3}$/.test(code) && code !== "und" ? code : null;
}

/** Un nom de gestionnaire est souvent l'enseigne du logiciel, pas un titre — on l'écarte alors. */
function meaningfulName(name: string): string | null {
  const trimmed = name.replace(/\0/g, "").trim();
  if (!trimmed) return null;
  if (/handler|^(core media|gpac|l-smash|mainconcept|isomedia|apple|bento4|mp4box)\b/i.test(trimmed)) return null;
  return trimmed;
}

function cString(bytes: Uint8Array, from: number, to: number): string {
  let end = from;
  while (end < to && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(from, end));
}

/** Le contenu d'un `esds` : le type d'objet et la configuration du décodeur (ISO 14496-1). */
function readEsds(bytes: Uint8Array, from: number, to: number): { objectType: number; config: Uint8Array | null } {
  let at = from + 4; // version et drapeaux
  let objectType = 0;
  let config: Uint8Array | null = null;
  const readLength = (): number => {
    let length = 0;
    for (let i = 0; i < 4 && at < to; i++) {
      const byte = bytes[at++];
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return length;
  };
  const walk = (end: number): void => {
    while (at + 2 <= end && config === null) {
      const tag = bytes[at++];
      const length = readLength();
      const payloadEnd = Math.min(at + length, end);
      if (tag === 0x03) {
        // ES_Descriptor : un identifiant, des drapeaux qui annoncent des champs optionnels.
        const flags = bytes[at + 2];
        at += 3;
        if (flags & 0x80) at += 2; // streamDependenceFlag
        if (flags & 0x40) at += 1 + bytes[at]; // URL_Flag
        if (flags & 0x20) at += 2; // OCRstreamFlag
        walk(payloadEnd);
      } else if (tag === 0x04) {
        objectType = bytes[at];
        at += 13;
        walk(payloadEnd);
      } else if (tag === 0x05) {
        config = bytes.slice(at, payloadEnd);
      }
      at = payloadEnd;
    }
  };
  walk(to);
  return { objectType, config };
}

/** Canaux par `acmod` (ATSC A/52, tableau 5.8), sans le LFE. */
const ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
const AC3_RATES = [48000, 44100, 32000];

/**
 * Le nombre de canaux d'un `dac3` — et pas celui de l'entrée d'échantillon.
 *
 * ETSI TS 102 366 fixe `channelcount` à 2 dans les entrées `ac-3`/`ec-3`, quel que soit le flux :
 * un lecteur doit le lire ici. Pris dans l'entrée, un 5.1 aurait été annoncé stéréo — aux
 * étiquettes, au choix « la plus riche d'abord », à l'unification des canaux.
 */
function dac3Format(bytes: Uint8Array, at: number): { channels: number; sampleRate: number } {
  const fscod = bytes[at] >> 6;
  const acmod = (bytes[at + 1] >> 3) & 0x07;
  const lfe = (bytes[at + 1] >> 2) & 0x01;
  return { channels: ACMOD_CHANNELS[acmod] + lfe, sampleRate: AC3_RATES[fscod] ?? 48000 };
}

/** Canaux ajoutés par chaque bit de `chan_loc` d'un flux dépendant (ETSI TS 102 366, E.1.3.1.8). */
const CHAN_LOC_CHANNELS = [2, 2, 1, 1, 2, 2, 2, 1, 1];

function dec3Format(bytes: Uint8Array, at: number, end: number): { channels: number; sampleRate: number } | null {
  // data_rate (13) · num_ind_sub (3), puis le premier flux indépendant — celui qui porte le programme.
  if (at + 5 > end) return null;
  let bit = (at + 2) * 8;
  const read = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i++, bit++) value = (value << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    return value;
  };
  const fscod = read(2);
  read(5); // bsid
  read(1); // réservé
  read(1); // asvc
  read(3); // bsmod
  const acmod = read(3);
  const lfe = read(1);
  read(3); // réservé
  const dependents = read(4);
  let channels = ACMOD_CHANNELS[acmod] + lfe;
  if (dependents > 0 && bit + 9 <= end * 8) {
    const location = read(9);
    for (let i = 0; i < 9; i++) if (location & (1 << (8 - i))) channels += CHAN_LOC_CHANNELS[i];
  }
  return { channels, sampleRate: AC3_RATES[fscod] ?? 48000 };
}

/** L'en-tête Ogg qu'un Matroska garde pour l'Opus, reconstruit depuis le `dOps` d'un MP4. */
function opusHeadFromDops(bytes: Uint8Array, from: number, to: number): Uint8Array | null {
  if (to - from < 11) return null;
  const dv = view(bytes);
  const channels = bytes[from + 1];
  const family = bytes[from + 10];
  const table = family === 0 ? new Uint8Array(0) : bytes.subarray(from + 11, Math.min(to, from + 13 + channels));
  const head = new Uint8Array(19 + table.length);
  const out = view(head);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // « OpusHead »
  head[8] = 1;
  head[9] = channels;
  out.setUint16(10, dv.getUint16(from + 2), true); // pre-skip
  out.setUint32(12, dv.getUint32(from + 4), true); // fréquence d'origine
  out.setInt16(16, dv.getInt16(from + 8), true); // gain
  head[18] = family;
  head.set(table, 19);
  return head;
}

/** STREAMINFO : fréquence (20 bits), canaux − 1 (3), profondeur − 1 (5), après 10 octets de tailles. */
function flacStreamInfo(blocks: Uint8Array): { sampleRate: number; channels: number; bitDepth: number } | null {
  if (blocks.length < 4 + 18 || (blocks[0] & 0x7f) !== 0) return null;
  const info = blocks.subarray(4);
  const sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  const channels = ((info[12] >> 1) & 0x07) + 1;
  const bitDepth = (((info[12] & 0x01) << 4) | (info[13] >> 4)) + 1;
  return { sampleRate, channels, bitDepth };
}

interface SampleEntryDescription {
  codecId: string;
  codecPrivate: Uint8Array | null;
  video?: MatroskaTrack["video"];
  audio?: MatroskaTrack["audio"];
  dolbyVision?: MatroskaTrack["dolbyVision"];
  /** Une image fixe — une pochette rangée comme une piste —, jamais le film. */
  still?: boolean;
  /** Du texte QuickTime (chapitres), pas des sous-titres. */
  chapters?: boolean;
}

/** `colr`, `mdcv`, `clli` : ce que le Matroska range dans `Colour`. */
function readColour(bytes: Uint8Array, boxes: Box[]): TrackColour | undefined {
  const dv = view(bytes);
  const colour: TrackColour = {};
  let any = false;
  for (const box of boxes) {
    if (box.type === "colr" && box.end - box.body >= 10) {
      const kind = fourcc(bytes, box.body);
      if (kind === "nclx" || kind === "nclc") {
        colour.primaries = dv.getUint16(box.body + 4);
        colour.transferCharacteristics = dv.getUint16(box.body + 6);
        colour.matrixCoefficients = dv.getUint16(box.body + 8);
        if (kind === "nclx" && box.end - box.body >= 11) colour.range = bytes[box.body + 10] & 0x80 ? 2 : 1;
        any = true;
      }
    } else if (box.type === "mdcv" && box.end - box.body >= 24) {
      // Six primaires et un point blanc sur 16 bits, puis la luminance maximale en 0,0001 cd/m².
      const nits = dv.getUint32(box.body + 16) / 10000;
      if (nits > 0) colour.masteringMaxNits = nits;
      any = true;
    } else if (box.type === "clli" && box.end - box.body >= 4) {
      const nits = dv.getUint16(box.body);
      if (nits > 0) colour.maxContentLightNits = nits;
      any = true;
    }
  }
  return any ? colour : undefined;
}

function describeVisual(bytes: Uint8Array, entry: Box): SampleEntryDescription {
  const dv = view(bytes);
  const width = dv.getUint16(entry.start + 32);
  const height = dv.getUint16(entry.start + 34);
  const boxes = children(bytes, entry.start + 86, entry.end);
  const payload = (type: string) => {
    const box = boxes.find((b) => b.type === type);
    // Recopié : la configuration vit toute la séance, le tampon du `moov` non.
    return box ? bytes.slice(box.body, box.end) : null;
  };
  const video: NonNullable<MatroskaTrack["video"]> = { width, height };
  const pasp = boxes.find((b) => b.type === "pasp");
  if (pasp && pasp.end - pasp.body >= 8) {
    const h = dv.getUint32(pasp.body);
    const v = dv.getUint32(pasp.body + 4);
    if (h > 0 && v > 0 && h !== v) {
      video.displayWidth = Math.round((width * h) / v);
      video.displayHeight = height;
    }
  }
  const colour = readColour(bytes, boxes);
  if (colour) video.colour = colour;

  const dvBox = boxes.find((b) => b.type === "dvcC" || b.type === "dvvC");
  const dolbyVision = dvBox ? { type: dvBox.type, record: bytes.slice(dvBox.body, dvBox.end) } : undefined;

  const type = entry.type;
  switch (type) {
    case "avc1":
    case "avc3":
    case "dvav":
    case "dva1":
      return { codecId: "V_MPEG4/ISO/AVC", codecPrivate: payload("avcC"), video, dolbyVision };
    case "hvc1":
    case "hev1":
    case "dvh1":
    case "dvhe":
      return { codecId: "V_MPEGH/ISO/HEVC", codecPrivate: payload("hvcC"), video, dolbyVision };
    case "av01":
      return { codecId: "V_AV1", codecPrivate: payload("av1C"), video };
    case "vp09":
      // vpcC n'est pas le CodecPrivate d'un Matroska, et le VP9 porte tout en bande.
      return { codecId: "V_VP9", codecPrivate: null, video };
    case "vp08":
      return { codecId: "V_VP8", codecPrivate: null, video };
    case "mp4v": {
      const esds = boxes.find((b) => b.type === "esds");
      const { objectType, config } = esds ? readEsds(bytes, esds.body, esds.end) : { objectType: 0, config: null };
      // 0x6C : du JPEG — une pochette, comme `jpeg` et `png ` ci-dessous.
      if (objectType === 0x6c || objectType === 0x6d) return { codecId: "V_MP4/jpeg", codecPrivate: null, video, still: true };
      if (objectType === 0x20) return { codecId: "V_MPEG4/ISO/ASP", codecPrivate: config, video };
      return { codecId: `V_MP4/mp4v-${objectType.toString(16)}`, codecPrivate: config, video };
    }
    case "jpeg":
    case "mjpa":
    case "mjpb":
    case "png ":
      return { codecId: `V_MP4/${type.trim()}`, codecPrivate: null, video, still: true };
    default:
      // Nommé tel quel, pour que le refus dise lequel : « V_MP4/encv » (chiffré), « V_MP4/apch »…
      return { codecId: `V_MP4/${type.trim()}`, codecPrivate: null, video };
  }
}

function describeAudio(bytes: Uint8Array, entry: Box): SampleEntryDescription {
  const dv = view(bytes);
  const version = dv.getUint16(entry.start + 16);
  let channels = dv.getUint16(entry.start + 24);
  let sampleRate = dv.getUint32(entry.start + 32) / 65536;
  let childrenAt = entry.start + 36;
  if (version === 1) childrenAt += 16;
  else if (version === 2) {
    // QuickTime v2 : la fréquence en flottant double et les canaux sur 32 bits, plus loin.
    sampleRate = dv.getFloat64(entry.start + 40);
    channels = dv.getUint32(entry.start + 48);
    childrenAt = entry.start + 72;
  }
  let boxes = children(bytes, childrenAt, entry.end);
  // QuickTime range la configuration dans une boîte `wave` — le `esds` d'un AAC d'un .mov y est.
  const wave = boxes.find((b) => b.type === "wave");
  if (wave) boxes = [...boxes, ...children(bytes, wave.body, wave.end)];
  const find = (type: string) => boxes.find((b) => b.type === type);
  const audio: NonNullable<MatroskaTrack["audio"]> = { sampleRate, channels };
  const type = entry.type;

  switch (type) {
    case "mp4a": {
      const esds = find("esds");
      const { objectType, config } = esds ? readEsds(bytes, esds.body, esds.end) : { objectType: 0x40, config: null };
      if (objectType === 0x6b || objectType === 0x69) return { codecId: "A_MPEG/L3", codecPrivate: null, audio };
      if (objectType === 0x40 || objectType === 0x66 || objectType === 0x67 || objectType === 0x68) {
        return { codecId: "A_AAC", codecPrivate: config, audio: aacAudio(config, audio) };
      }
      return { codecId: `A_MP4/mp4a-${objectType.toString(16)}`, codecPrivate: config, audio };
    }
    case "ac-3": {
      const dac3 = find("dac3");
      // Pas de CodecPrivate, comme dans un Matroska : le remultiplexeur décrit l'AC-3 depuis une
      // trame (voir `describeAudio` dans remuxer.ts), la même voie pour les deux conteneurs.
      return { codecId: "A_AC3", codecPrivate: null, audio: dac3 && dac3.end - dac3.body >= 3 ? dac3Format(bytes, dac3.body) : audio };
    }
    case "ec-3": {
      const dec3 = find("dec3");
      const format = dec3 ? dec3Format(bytes, dec3.body, dec3.end) : null;
      return { codecId: "A_EAC3", codecPrivate: null, audio: format ?? audio };
    }
    case "Opus": {
      const dOps = find("dOps");
      const head = dOps ? opusHeadFromDops(bytes, dOps.body, dOps.end) : null;
      // L'Opus sort toujours à 48 kHz ; la fréquence d'origine du dOps n'est qu'une information.
      return { codecId: "A_OPUS", codecPrivate: head, audio: { sampleRate: 48000, channels: head ? head[9] : channels } };
    }
    case "fLaC": {
      const dfLa = find("dfLa");
      // Le Matroska garde l'en-tête du fichier FLAC : « fLaC » puis les blocs de métadonnées — le
      // contenu du dfLa, à ses quatre octets de version près.
      const blocks = dfLa ? bytes.slice(dfLa.body + 4, dfLa.end) : null;
      const codecPrivate = blocks ? new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...blocks]) : null;
      const info = blocks ? flacStreamInfo(blocks) : null;
      return {
        codecId: "A_FLAC",
        codecPrivate,
        audio: info ? { sampleRate: info.sampleRate, channels: info.channels, bitDepth: info.bitDepth } : audio,
      };
    }
    case "mlpa":
      return { codecId: "A_TRUEHD", codecPrivate: null, audio };
    case "dtsc":
    case "dtsh":
    case "dtsl":
    case "dtse":
      return { codecId: "A_DTS", codecPrivate: null, audio };
    case ".mp3":
      return { codecId: "A_MPEG/L3", codecPrivate: null, audio };
    default:
      return { codecId: `A_MP4/${type.trim()}`, codecPrivate: null, audio };
  }
}

/** Les fréquences qu'une AudioSpecificConfig nomme par leur rang. */
const ASC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Fréquence et canaux d'un AAC tels que sa configuration les dit.
 *
 * L'entrée d'échantillon les répète, mais mal au-delà du simple : son champ de fréquence est en
 * 16.16 (rien au-dessus de 65 535 Hz), et ses canaux valent souvent 2 quel que soit le flux. La
 * configuration fait foi ; l'entrée ne reste la source que là où la configuration renvoie
 * ailleurs (canaux décrits par un PCE, configuration 0) ou quand SBR double la fréquence de
 * sortie — ce que le Matroska range dans OutputSamplingFrequency, et ce que `parseMatroska`
 * retient.
 */
function aacAudio(config: Uint8Array | null, entry: NonNullable<MatroskaTrack["audio"]>): NonNullable<MatroskaTrack["audio"]> {
  if (!config || config.length < 2) return entry;
  const objectType = config[0] >> 3;
  const core = ASC_RATES[((config[0] & 0x07) << 1) | (config[1] >> 7)];
  const configuration = (config[1] >> 3) & 0x0f;
  const channels = configuration === 7 ? 8 : configuration >= 1 && configuration <= 6 ? configuration : entry.channels;
  const sbr = objectType === 5 || objectType === 29 || entry.sampleRate === 2 * (core ?? 0);
  const sampleRate = core === undefined ? entry.sampleRate : sbr ? Math.max(entry.sampleRate, core) : core;
  return { ...entry, sampleRate, channels };
}

function describeEntry(bytes: Uint8Array, handler: string, entry: Box): SampleEntryDescription & { type: MatroskaTrack["type"] } {
  if (handler === "vide") return { type: "video", ...describeVisual(bytes, entry) };
  if (handler === "soun") return { type: "audio", ...describeAudio(bytes, entry) };
  if (handler === "sbtl" || handler === "text" || handler === "subt") {
    if (entry.type === "tx3g") return { type: "subtitle", codecId: "S_TEXT/UTF8", codecPrivate: null };
    // Le texte QuickTime sert aux chapitres ; wvtt, stpp et le reste ne sont pas lus ici.
    if (entry.type === "text") return { type: "other", codecId: "S_MP4/text", codecPrivate: null, chapters: true };
    return { type: "subtitle", codecId: `S_MP4/${entry.type.trim()}`, codecPrivate: null };
  }
  return { type: "other", codecId: `D_MP4/${handler.trim() || "?"}`, codecPrivate: null };
}

// ─── Tables d'échantillons ────────────────────────────────────────────────────────────────────

interface RawTrack {
  track: MatroskaTrack;
  enabled: boolean;
  index: Mp4TrackIndex | null;
  still: boolean;
  chapters: boolean;
  sampleCount: number;
  durationSeconds: number;
}

function sampleTable(
  bytes: Uint8Array,
  stbl: Box,
  number: number,
  timescale: number,
  shiftTicks: number,
  timedText: boolean
): Mp4TrackIndex | null {
  const dv = view(bytes);
  const boxes = children(bytes, stbl.body, stbl.end);
  const find = (type: string) => boxes.find((b) => b.type === type);

  // Tailles : stsz, ou sa forme compacte stz2.
  let sizes: Uint32Array;
  const stsz = find("stsz");
  const stz2 = find("stz2");
  if (stsz) {
    const fixed = dv.getUint32(stsz.body + 4);
    const count = dv.getUint32(stsz.body + 8);
    sizes = new Uint32Array(count);
    if (fixed !== 0) sizes.fill(fixed);
    else for (let i = 0; i < count; i++) sizes[i] = dv.getUint32(stsz.body + 12 + i * 4);
  } else if (stz2) {
    const field = bytes[stz2.body + 7];
    const count = dv.getUint32(stz2.body + 8);
    sizes = new Uint32Array(count);
    const at = stz2.body + 12;
    for (let i = 0; i < count; i++) {
      if (field === 16) sizes[i] = dv.getUint16(at + i * 2);
      else if (field === 8) sizes[i] = bytes[at + i];
      else sizes[i] = (bytes[at + (i >> 1)] >> (i & 1 ? 0 : 4)) & 0x0f;
    }
  } else return null;
  const count = sizes.length;
  if (count === 0) return null;

  // Décalages : chaque bloc (stco/co64) contient des échantillons consécutifs, en nombre donné par stsc.
  const stco = find("stco");
  const co64 = find("co64");
  const chunkCount = stco ? dv.getUint32(stco.body + 4) : co64 ? dv.getUint32(co64.body + 4) : 0;
  const chunkOffset = (c: number) => (stco ? dv.getUint32(stco.body + 8 + c * 4) : u64(dv, co64!.body + 8 + c * 8));
  const stsc = find("stsc");
  if (!stsc || chunkCount === 0) return null;
  const runs = dv.getUint32(stsc.body + 4);
  const offsets = new Float64Array(count);
  let sample = 0;
  for (let r = 0; r < runs && sample < count; r++) {
    const firstChunk = dv.getUint32(stsc.body + 8 + r * 12) - 1;
    const perChunk = dv.getUint32(stsc.body + 12 + r * 12);
    const nextFirst = r + 1 < runs ? dv.getUint32(stsc.body + 8 + (r + 1) * 12) - 1 : chunkCount;
    for (let c = firstChunk; c < nextFirst && c < chunkCount && sample < count; c++) {
      let at = chunkOffset(c);
      for (let k = 0; k < perChunk && sample < count; k++) {
        offsets[sample] = at;
        at += sizes[sample];
        sample++;
      }
    }
  }
  if (sample < count) return null;

  // Instants : stts donne les écarts de décodage, ctts le décalage de présentation.
  const stts = find("stts");
  if (!stts) return null;
  const dtsTicks = new Float64Array(count);
  let tick = 0;
  let lastDelta = 0;
  sample = 0;
  const sttsRuns = dv.getUint32(stts.body + 4);
  for (let r = 0; r < sttsRuns && sample < count; r++) {
    const n = dv.getUint32(stts.body + 8 + r * 8);
    const delta = dv.getUint32(stts.body + 12 + r * 8);
    for (let k = 0; k < n && sample < count; k++) {
      dtsTicks[sample++] = tick;
      tick += delta;
    }
    lastDelta = delta;
  }
  while (sample < count) {
    dtsTicks[sample++] = tick;
    tick += lastDelta;
  }

  const usPerTick = 1e6 / timescale;
  const dtsUs = new Float64Array(count);
  for (let i = 0; i < count; i++) dtsUs[i] = Math.round((dtsTicks[i] - shiftTicks) * usPerTick);

  let ctsUs: Int32Array | null = null;
  const ctts = find("ctts");
  if (ctts) {
    ctsUs = new Int32Array(count);
    const cttsRuns = dv.getUint32(ctts.body + 4);
    sample = 0;
    for (let r = 0; r < cttsRuns && sample < count; r++) {
      const n = dv.getUint32(ctts.body + 8 + r * 8);
      // Signé dans les deux versions : FFmpeg le lit ainsi, et des multiplexeurs écrivent des
      // décalages négatifs en version 0.
      const offset = dv.getInt32(ctts.body + 12 + r * 8);
      for (let k = 0; k < n && sample < count; k++, sample++) {
        // Arrondi depuis les tics absolus, comme le décodage : pas d'erreur qui s'accumule.
        ctsUs[sample] = Math.round((dtsTicks[sample] + offset - shiftTicks) * usPerTick) - dtsUs[sample];
      }
    }
  }

  let sync: Uint8Array | null = null;
  const stss = find("stss");
  if (stss) {
    sync = new Uint8Array(count);
    const n = dv.getUint32(stss.body + 4);
    for (let k = 0; k < n; k++) {
      const index = dv.getUint32(stss.body + 8 + k * 4) - 1;
      if (index >= 0 && index < count) sync[index] = 1;
    }
  }

  return { number, offsets, sizes, dtsUs, ctsUs, sync, lastDurationUs: Math.round(lastDelta * usPerTick), timedText };
}

function readTrak(bytes: Uint8Array, trak: Box, movieTimescale: number): RawTrack | null {
  const dv = view(bytes);
  const tkhd = child(bytes, trak, "tkhd");
  const mdia = child(bytes, trak, "mdia");
  const mdhd = mdia && child(bytes, mdia, "mdhd");
  const hdlr = mdia && child(bytes, mdia, "hdlr");
  const stbl = mdia && path(bytes, mdia, "minf", "stbl");
  if (!tkhd || !mdhd || !hdlr || !stbl) return null;

  const tkhdVersion = bytes[tkhd.body];
  const enabled = (bytes[tkhd.body + 3] & 0x01) !== 0;
  const number = dv.getUint32(tkhd.body + (tkhdVersion === 1 ? 20 : 12));

  const mdhdVersion = bytes[mdhd.body];
  const timescale = dv.getUint32(mdhd.body + (mdhdVersion === 1 ? 20 : 12));
  const mediaDuration = mdhdVersion === 1 ? u64(dv, mdhd.body + 24) : dv.getUint32(mdhd.body + 16);
  const language = mdhdLanguage(dv.getUint16(mdhd.body + (mdhdVersion === 1 ? 32 : 20)) & 0x7fff);
  if (!timescale) return null;

  const handler = fourcc(bytes, hdlr.body + 8);
  const handlerName = cString(bytes, hdlr.body + 24, hdlr.end);

  const stsd = child(bytes, stbl, "stsd");
  const entry = stsd ? children(bytes, stsd.body + 8, stsd.end)[0] : undefined;
  if (!entry) return null;
  const described = describeEntry(bytes, handler, entry);

  // Le titre : `udta/name` quand il existe, sinon le nom du gestionnaire s'il en est un vrai.
  const name = path(bytes, trak, "udta", "name");
  const title = name ? meaningfulName(new TextDecoder().decode(bytes.subarray(name.body, name.end))) : meaningfulName(handlerName);

  // La liste de montage : une entrée vide (décalage du début), puis la première entrée média. Le
  // même calcul que mediabunny — qui décode le son ré-encodé — et que FFmpeg : sans cela, le son
  // copié et le son ré-encodé d'un même fichier ne tomberaient pas au même instant.
  let shiftTicks = 0;
  const elst = path(bytes, trak, "edts", "elst");
  if (elst) {
    const version = bytes[elst.body];
    const entries = dv.getUint32(elst.body + 4);
    let empty = 0;
    let media: number | null = null;
    const size = version === 1 ? 20 : 12;
    for (let e = 0; e < entries; e++) {
      const at = elst.body + 8 + e * size;
      const segment = version === 1 ? u64(dv, at) : dv.getUint32(at);
      const mediaTime = version === 1 ? i64(dv, at + 8) : dv.getInt32(at + 4);
      if (mediaTime === -1) {
        empty += segment;
        continue;
      }
      media = mediaTime;
      if (e + 1 < entries) trace(`mp4 : piste ${number}, liste de montage à ${entries} entrées — seule la première est suivie`);
      break;
    }
    if (media !== null) shiftTicks = media - Math.round((empty / (movieTimescale || 1)) * timescale);
  }

  const track: MatroskaTrack = {
    number,
    type: described.still ? "other" : described.type,
    codecId: described.codecId,
    codecPrivate: described.codecPrivate,
    language,
    name: title,
    isDefault: false,
    isForced: false,
    isHearingImpaired: false,
    // `tkhd` a bien un drapeau « activée », mais il ne dit pas ce que dit FlagEnabled : FFmpeg et
    // la plupart des multiplexeurs n'activent que la première piste de chaque type — c'est un
    // drapeau « par défaut », lu comme tel plus bas. Le reprendre ici aurait retiré du menu six
    // pistes de sous-titres sur six d'un film de la bibliothèque.
    isEnabled: true,
    defaultDurationNs: null,
  };
  if (described.video) track.video = described.video;
  if (described.audio) track.audio = described.audio;
  if (described.dolbyVision) track.dolbyVision = described.dolbyVision;

  // Rien à lire pour ce qu'on ne lira jamais : pochettes, chapitres, pistes de données.
  const indexed = track.type !== "other" && !described.chapters;
  const index = indexed ? sampleTable(bytes, stbl, number, timescale, shiftTicks, track.codecId === "S_TEXT/UTF8") : null;
  const sampleCount = index?.sizes.length ?? 0;
  if (index && sampleCount > 1) {
    const d = index.dtsUs[1] - index.dtsUs[0];
    let constant = true;
    for (let i = 2; i < Math.min(sampleCount, 64) && constant; i++) constant = index.dtsUs[i] - index.dtsUs[i - 1] === d;
    if (constant && track.type === "video") track.defaultDurationNs = d * 1000;
  }
  return {
    track,
    enabled,
    index,
    still: !!described.still,
    chapters: !!described.chapters,
    sampleCount,
    durationSeconds: mediaDuration / timescale,
  };
}

// ─── Le fichier ───────────────────────────────────────────────────────────────────────────────

function lowerBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * L'index de saut, depuis les images de synchronisation de la piste vidéo.
 *
 * Une position est le plus petit décalage parmi les échantillons (toutes pistes) décodés à partir
 * de l'image clé : lire depuis là rend l'image clé *et* le son qui l'entoure. C'est ce que la
 * position d'une grappe vaut dans un Matroska, et ce dont se servent la zone gardée
 * (`keptRangeAt`) et le préchargement d'un saut (`warm`).
 */
function buildCues(video: Mp4TrackIndex, all: Mp4TrackIndex[], starts: Map<number, number>): CuePoint[] {
  // Le minimum des décalages de chaque piste à partir de chaque rang — temporaire, jeté ensuite.
  const suffixMin = all.map((t) => {
    const m = new Float64Array(t.offsets.length + 1);
    m[t.offsets.length] = Infinity;
    for (let i = t.offsets.length - 1; i >= 0; i--) m[i] = Math.min(t.offsets[i], m[i + 1]);
    return m;
  });
  const cues: CuePoint[] = [];
  for (let k = 0; k < video.dtsUs.length; k++) {
    if (video.sync && !video.sync[k]) continue;
    const kfDts = video.dtsUs[k];
    let position = Infinity;
    all.forEach((t, i) => {
      position = Math.min(position, suffixMin[i][lowerBound(t.dtsUs, kfDts)]);
    });
    if (!Number.isFinite(position)) continue;
    const known = starts.get(position);
    if (known === undefined || kfDts < known) starts.set(position, kfDts);
    cues.push({ track: video.number, timeUs: kfDts + (video.ctsUs?.[k] ?? 0), clusterOffset: position });
  }
  cues.sort((a, b) => a.timeUs - b.timeUs);
  return cues;
}

const parsed = new Map<string, MatroskaFile>();
const MAX_REMEMBERED_HEADERS = 4;

/** Oublie la description d'un fichier — pour qui a des raisons de le croire changé. */
export function forgetMp4Header(key: string): void {
  parsed.delete(key);
}

/**
 * Lit la description d'un MP4, dans la forme d'un Matroska lu. Gardée sous `key`, comme
 * `parseMatroska` : rouvrir le même film — ou le reconstruire — ne relit rien.
 */
export async function parseMp4(source: ByteSource, key?: string): Promise<MatroskaFile> {
  const remembered = key === undefined ? undefined : parsed.get(key);
  if (remembered && remembered.segmentEnd <= source.size) return remembered;
  const file = await readMp4(source);
  if (key !== undefined) {
    parsed.set(key, file);
    while (parsed.size > MAX_REMEMBERED_HEADERS) {
      const oldest = parsed.keys().next().value;
      if (oldest === undefined) break;
      parsed.delete(oldest);
    }
  }
  return file;
}

async function readMp4(source: ByteSource): Promise<MatroskaFile> {
  const top = await topLevel(source);
  const moovBox = top.find((b) => b.type === "moov");
  if (top.some((b) => b.type === "moof")) {
    throw new Mp4Refusal("MP4 fragmenté : non pris en charge par ce lecteur.");
  }
  if (!moovBox) throw new Mp4Refusal("MP4 sans description (boîte moov introuvable).");

  // Le `moov` entier, en une lecture : il est petit devant le film (quelques mégaoctets pour
  // trois heures), et le parcourir champ par champ coûterait une lecture par champ.
  const bytes = await source.read(moovBox.start, moovBox.end - moovBox.start);
  const moov: Box = { type: "moov", start: 0, body: moovBox.body - moovBox.start, end: bytes.length };
  const dv = view(bytes);

  if (child(bytes, moov, "mvex")) throw new Mp4Refusal("MP4 fragmenté : non pris en charge par ce lecteur.");

  const mvhd = child(bytes, moov, "mvhd");
  let movieTimescale = 1000;
  let movieDuration = 0;
  if (mvhd) {
    const v = bytes[mvhd.body];
    movieTimescale = dv.getUint32(mvhd.body + (v === 1 ? 20 : 12)) || 1000;
    movieDuration = v === 1 ? u64(dv, mvhd.body + 24) : dv.getUint32(mvhd.body + 16);
  }

  const traks = children(bytes, moov.body, moov.end).filter((b) => b.type === "trak");
  // Les pistes de chapitres, nommées par la référence `tref/chap` d'une autre.
  const chapterTracks = new Set<number>();
  for (const trak of traks) {
    const chap = path(bytes, trak, "tref", "chap");
    if (chap) for (let at = chap.body; at + 4 <= chap.end; at += 4) chapterTracks.add(dv.getUint32(at));
  }

  const raw = traks.map((trak) => readTrak(bytes, trak, movieTimescale)).filter((t): t is RawTrack => t !== null);
  for (const r of raw) {
    if (chapterTracks.has(r.track.number) && r.track.type !== "video" && r.track.type !== "audio") {
      r.track.type = "other";
      r.index = null;
    }
  }

  // Une piste vidéo d'une seule image est une pochette, pas un film.
  for (const r of raw) {
    if (r.track.type === "video" && r.sampleCount <= 1) {
      r.track.type = "other";
      r.index = null;
    }
  }
  const withSamples = raw.filter((r) => r.index !== null);
  if (withSamples.length === 0) {
    // Des pistes et aucun échantillon : c'est la forme d'un MP4 fragmenté dont on n'aurait pas vu
    // les `moof` — ou d'un fichier vide. Dans les deux cas, rien à lire ici.
    throw new Mp4Refusal("MP4 fragmenté : non pris en charge par ce lecteur.");
  }

  /**
   * Une seule piste vidéo : celle qui a le plus d'images.
   *
   * `remuxPlayback` prend la première piste vidéo du fichier, et un MP4 range volontiers devant le
   * film une pochette, une vignette ou un second angle. Les autres pistes vidéo deviennent
   * « autres » : ce lecteur n'a pas de menu d'angles, et une pochette choisie comme film donnerait
   * une image fixe d'une seconde.
   */
  const videos = withSamples.filter((r) => r.track.type === "video");
  const main = videos.reduce<RawTrack | null>((best, r) => (!best || r.sampleCount > best.sampleCount ? r : best), null);
  for (const r of videos) {
    if (r !== main) {
      r.track.type = "other";
      r.index = null;
    }
  }

  /**
   * « Par défaut » : la première piste activée de chaque type, sinon la première tout court.
   *
   * MP4 n'a pas de drapeau « par défaut ». Le drapeau « activée » de `tkhd` en tient lieu chez
   * FFmpeg, qui n'active que la piste par défaut de chaque type — et c'est ce que Jellyfin en
   * rapporte (la VF d'un fichier à huit pistes audio y est la seule `default=1`).
   */
  for (const type of ["video", "audio", "subtitle"] as const) {
    const ofType = raw.filter((r) => r.track.type === type);
    const chosen = ofType.find((r) => r.enabled) ?? (type === "subtitle" ? undefined : ofType[0]);
    if (chosen) chosen.track.isDefault = true;
  }

  const indexes = raw.map((r) => r.index).filter((i): i is Mp4TrackIndex => i !== null);
  const starts = new Map<number, number>();
  const videoIndex = main?.index ?? null;
  const cues = videoIndex ? buildCues(videoIndex, indexes, starts) : [];

  let firstOffset = Infinity;
  for (const index of indexes) for (let i = 0; i < index.offsets.length; i++) firstOffset = Math.min(firstOffset, index.offsets[i]);
  // Le début du fichier : chaque piste depuis son premier échantillon.
  starts.set(firstOffset, -Infinity);

  const durationSeconds =
    movieDuration > 0 ? movieDuration / movieTimescale : Math.max(0, ...raw.map((r) => r.durationSeconds)) || null;

  const mdat = top.findIndex((b) => b.type === "mdat");
  const moovFirst = mdat < 0 || top.indexOf(moovBox) < mdat;
  trace(
    `mp4 : ${raw.length} pistes, ${indexes.reduce((n, i) => n + i.sizes.length, 0)} échantillons, ` +
      `${cues.length} points d'accès, moov ${moovFirst ? "en tête" : "en fin"}`
  );

  return {
    timestampScaleNs: 1000,
    durationSeconds,
    tracks: raw.map((r) => r.track),
    cues,
    segmentDataStart: 0,
    segmentEnd: source.size,
    firstClusterOffset: firstOffset,
    mp4: { tracks: indexes, starts },
  };
}

// ─── Lecture des échantillons ─────────────────────────────────────────────────────────────────

/**
 * Le pendant de `SampleReader` pour un MP4 : les échantillons de toutes les pistes, **dans l'ordre
 * du temps de décodage**, à partir d'une position d'index.
 *
 * Pas dans l'ordre des octets, comme on le ferait d'un Matroska. Un Matroska range ses grappes par
 * temps ; un MP4 range ses blocs comme son multiplexeur l'a voulu, et rien n'oblige le son à
 * suivre l'image de près — certains fichiers mettent toute la vidéo puis tout le son. Lu dans
 * l'ordre des octets, un tel fichier livrerait des minutes d'image sans un échantillon de son, et
 * MediaSource ne joue que l'intersection des deux tampons. Dans l'ordre du temps, les deux avancent
 * ensemble quel que soit le rangement ; sur un fichier bien entrelacé — tous ceux de la
 * bibliothèque — cela revient au même, à quelques allers-retours près dans le même mégaoctet, que
 * le cache de la source absorbe.
 */
export class Mp4SampleReader {
  private readonly cursors: number[];
  private finished = false;

  constructor(
    private readonly source: ByteSource,
    private readonly file: MatroskaFile,
    startOffset: number
  ) {
    this.cursors = this.index.tracks.map(() => 0);
    this.seekTo(startOffset);
  }

  private get index(): Mp4Index {
    return this.file.mp4!;
  }

  /** Repart d'une position d'index — celle d'une image clé, ou le début du fichier. */
  seekTo(offset: number): void {
    const tracks = this.index.tracks;
    let from = this.index.starts.get(offset);
    if (from === undefined) {
      // Une position qui ne vient pas de l'index : le plus tôt des échantillons rangés à partir de
      // là, piste par piste. Aucun appelant n'en donne aujourd'hui ; c'est le filet.
      from = Infinity;
      for (const t of tracks) {
        for (let i = 0; i < t.offsets.length; i++) {
          if (t.offsets[i] >= offset) {
            from = Math.min(from, t.dtsUs[i]);
            break;
          }
        }
      }
    }
    for (let i = 0; i < tracks.length; i++) {
      this.cursors[i] = from === -Infinity ? 0 : lowerBound(tracks[i].dtsUs, from);
    }
    this.finished = false;
  }

  get exhausted(): boolean {
    return this.finished;
  }

  async next(): Promise<MediaSample | null> {
    const tracks = this.index.tracks;
    let pick = -1;
    for (let i = 0; i < tracks.length; i++) {
      const at = this.cursors[i];
      if (at >= tracks[i].dtsUs.length) continue;
      if (pick < 0) {
        pick = i;
        continue;
      }
      const best = tracks[pick];
      const bestAt = this.cursors[pick];
      const d = tracks[i].dtsUs[at] - best.dtsUs[bestAt];
      if (d < 0 || (d === 0 && tracks[i].offsets[at] < best.offsets[bestAt])) pick = i;
    }
    if (pick < 0) {
      this.finished = true;
      return null;
    }

    const track = tracks[pick];
    const i = this.cursors[pick]++;
    let data = await this.source.read(track.offsets[i], track.sizes[i]);
    if (track.timedText) data = timedText(data);
    const durationUs = i + 1 < track.dtsUs.length ? track.dtsUs[i + 1] - track.dtsUs[i] : track.lastDurationUs;
    return {
      trackNumber: track.number,
      timestampUs: track.dtsUs[i] + (track.ctsUs?.[i] ?? 0),
      durationUs,
      isKey: track.sync ? track.sync[i] === 1 : true,
      data,
    };
  }
}

/**
 * Le texte d'un échantillon mov_text (3GPP TS 26.245) : sa longueur sur deux octets, le texte en
 * UTF-8, puis des boîtes de style qu'on laisse. Un échantillon vide — longueur nulle — est le
 * silence entre deux répliques : il rend un texte vide, que les sous-titres ignorent comme ils
 * ignorent un bloc Matroska sans texte.
 */
export function timedText(data: Uint8Array): Uint8Array {
  if (data.length < 2) return new Uint8Array(0);
  const length = (data[0] << 8) | data[1];
  return data.subarray(2, Math.min(data.length, 2 + length));
}
