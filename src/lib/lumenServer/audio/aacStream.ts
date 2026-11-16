// L'AAC tel que le HLS d'Apple le veut : le SBR implicite rendu explicite, et une trame de silence.
// DECISIONS.md §159, docs/remux-serveur/README.md « Étape 3d ».
//
// **Le SBR implicite.** Un HE-AAC « implicite » a une AudioSpecificConfig d'AAC-LC à mi-fréquence (24 kHz
// pour un son à 48 kHz) : le SBR, qui double la fréquence, n'est annoncé que dans le flux, par un élément
// FIL d'extension `EXT_SBR_DATA` (13) ou `EXT_SBR_DATA_CRC` (14) derrière chaque élément de canaux. Un
// décodeur le découvre à la première trame (FFmpeg : `decode_extension_payload`, et « Implicit SBR was found
// with a first occurrence after the first frame » s'il ne le voit qu'après). La HLS Authoring Specification
// l'interdit en fMP4 : « 2.24. HE-AAC in fMP4 files MUST use explicit signaling of SBR data ». 6,3 % de la
// bibliothèque refusés pour cela seul au recensement de §157.
//
// La réparation ne touche aucune trame : la configuration de l'init est réécrite **en signalisation
// hiérarchique** (ISO/IEC 14496-3 §1.6.5.2 ; `2B 11 88 00` pour un stéréo 24 → 48 kHz) — type d'objet 5
// (SBR), fréquence du cœur, configuration de canaux, fréquence de l'extension, puis le type du cœur (2) et
// sa GASpecificConfig recopiée. Pourquoi la hiérarchique et non la rétrocompatible (LC suivie de
// l'extension de synchronisation 0x2B7) :
// - **Apple lit `CODECS` contre l'init.** La liste dit `mp4a.40.5` (« HE-AAC audio », table des valeurs
//   CODECS de la spécification) ; en hiérarchique le premier type d'objet de la configuration *est* 5, et
//   tout lecteur qui déduit la chaîne de l'init (RFC 6381 : le type d'objet de l'AudioSpecificConfig) dit
//   la même chose que la liste. En rétrocompatible, le premier type est 2 : la configuration se lit
//   `mp4a.40.2` pendant que la liste dit 40.5 — exactement la contradiction qu'un décodeur d'Apple ne
//   pardonne pas en MediaSource (`parseAacConfig`, « tears down the whole MediaSource »).
// - **La compatibilité descendante ne sert à rien ici** : elle existe pour qu'un décodeur sans SBR joue le
//   cœur à mi-fréquence ; tous les appareils Apple décodent le HE-AAC (règle 2.2, 2.5).
// - `parseAacConfig` (lecteur, `hlsSignal.ts`) lit déjà la forme hiérarchique : la liste et l'entrée
//   d'échantillon disent alors 48 kHz et `mp4a.40.5` sans rien de neuf.
// La fréquence de l'entrée `mp4a` devient celle de l'extension (48 000) et le nombre de canaux celui de la
// configuration : une seule histoire dans toute l'init.
//
// **Vérifier, jamais supposer.** Le nom du codec (Jellyfin dit « HE-AAC ») et la fréquence de sortie du
// Matroska (`OutputSamplingFrequency`, ce que le muxer a cru) ne prouvent rien. On parcourt la trame
// (`readRawDataBlock`) — éléments de canaux décodés jusqu'au dernier bit de leurs données spectrales, sans
// rien déquantifier — pour trouver ce qui suit chaque élément ; une trame n'est « lue » que si le parcours
// tombe exactement sur sa fin. Le lecteur actuel ne fait rien de tel : il copie la configuration implicite
// en MediaSource, où le décodeur du navigateur découvre le SBR lui-même.
//
// **Ce qui reste refusé** (`aacHlsPlan`) : un cœur mono à SBR implicite (`son-aac-ps-implicite`) — la
// stéréo paramétrique (HE-AAC v2, `mp4a.40.29`) se signale *dans* les données SBR (`bs_extension_id` 2),
// qu'il faudrait décoder (enveloppes de Huffman, tables de fréquences dérivées de l'en-tête SBR) pour savoir
// si elle est là ; FFmpeg lui-même la suppose (« Treating HE-AAC mono as stereo »). Annoncer 40.5 mono pour
// un v2, ou 40.29 pour un v1, serait un pari. Aussi : un flux qu'on ne sait pas lire jusqu'au bout, des trames
// qui ne disent pas toutes la même chose, une configuration qui annonce le SBR absent.
//
// **La trame de silence** (`silentAacFrame`) : chaque élément de canaux (SCE, CPE, LFE — ceux de la
// configuration 1 à 7, dans l'ordre de la norme, tableau 1.19) en fenêtre longue, `max_sfb` = 0 — aucune bande,
// aucun facteur, aucun coefficient —, puis END. Décodée, elle rend des zéros exacts, et elle laisse le
// décodeur dans l'état d'un décodeur neuf (recouvrement nul, fenêtre sinus) : la vraie trame qui la suit se
// décode à l'identique de son décodage depuis le début du fichier (le banc le mesure).

import { AAC_SCALEFACTOR_BITS, AAC_SCALEFACTOR_CODES, AAC_SPECTRAL_BOOKS, AAC_SWB_OFFSETS_LONG, AAC_SWB_OFFSETS_SHORT } from "./aacTables";
import { BitReader, BitWriter } from "./bits";

/** Les fréquences d'une AudioSpecificConfig, par indice (ISO/IEC 14496-3, tableau 1.18). */
export const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Une erreur de syntaxe : la trame n'a pas la forme qu'on croyait. Jamais montrée telle quelle. */
export class AacSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AacSyntaxError";
  }
}

// ── La configuration ─────────────────────────────────────────────────────────

export interface AscFacts {
  /** Le premier type d'objet : 2 (LC), 5 (SBR hiérarchique), 29 (PS hiérarchique)… */
  objectType: number;
  /** Le type du cœur : `objectType` hors signalisation hiérarchique. */
  coreObjectType: number;
  /** L'indice de fréquence du cœur (jamais l'échappement 15 : refusé à la lecture). */
  frequencyIndex: number;
  channelConfiguration: number;
  frameLengthFlag: number;
  dependsOnCoreCoder: number;
  extensionFlag: number;
  /**
   * Ce que la configuration dit du SBR : `hierarchique` (type 5 ou 29 en tête), `synchro` (extension 0x2B7,
   * SBR présent), `absent` (extension 0x2B7 qui le dit absent), `non-dit` (rien : implicite possible).
   */
  sbr: "hierarchique" | "synchro" | "absent" | "non-dit";
  /** L'indice de fréquence de l'extension, quand la configuration le dit. */
  extensionFrequencyIndex: number | null;
}

/** Ce qu'une AudioSpecificConfig dit, ou null pour une forme que ce module ne lit pas (échappements, PCE…). */
export function readAsc(asc: Uint8Array): AscFacts | null {
  try {
    const r = new BitReader(asc);
    const objectTypeOf = () => {
      const t = r.read(5);
      return t === 31 ? 32 + r.read(6) : t;
    };
    const objectType = objectTypeOf();
    const frequencyIndex = r.read(4);
    if (frequencyIndex >= AAC_RATES.length) return null; // 15 : fréquence écrite en clair, jamais vue ici
    const channelConfiguration = r.read(4);
    let coreObjectType = objectType;
    let sbr: AscFacts["sbr"] = "non-dit";
    let extensionFrequencyIndex: number | null = null;
    if (objectType === 5 || objectType === 29) {
      sbr = "hierarchique";
      extensionFrequencyIndex = r.read(4);
      if (extensionFrequencyIndex >= AAC_RATES.length) return null;
      coreObjectType = objectTypeOf();
    }
    // GASpecificConfig (§4.4.1) : seulement pour les types que ce module sait parcourir.
    if (coreObjectType !== 2) return { objectType, coreObjectType, frequencyIndex, channelConfiguration, frameLengthFlag: 0, dependsOnCoreCoder: 0, extensionFlag: 0, sbr, extensionFrequencyIndex };
    const frameLengthFlag = r.read(1);
    const dependsOnCoreCoder = r.read(1);
    if (dependsOnCoreCoder) r.skip(14);
    const extensionFlag = r.read(1);
    if (channelConfiguration === 0) return null; // un PCE suit : `son-aac-pce`, décidé ailleurs
    if (sbr === "non-dit" && r.left >= 16) {
      // L'extension de synchronisation (signalisation rétrocompatible, §1.6.5.2).
      const sync = r.read(11);
      if (sync === 0x2b7) {
        const extension = objectTypeOf();
        if (extension === 5) {
          if (r.read(1)) {
            sbr = "synchro";
            extensionFrequencyIndex = r.read(4);
            if (extensionFrequencyIndex >= AAC_RATES.length) return null;
          } else sbr = "absent";
        }
      }
    }
    return { objectType, coreObjectType, frequencyIndex, channelConfiguration, frameLengthFlag, dependsOnCoreCoder, extensionFlag, sbr, extensionFrequencyIndex };
  } catch {
    return null;
  }
}

/**
 * La configuration hiérarchique d'un HE-AAC v1 dont le cœur est décrit par `core` : type 5, fréquence du
 * cœur, canaux, fréquence de l'extension (le double), type 2, GASpecificConfig du cœur. Null si le double
 * n'est pas une fréquence de la table (un cœur au-dessus de 48 kHz).
 */
export function explicitSbrConfig(core: AscFacts): Uint8Array | null {
  // Au-delà de 48 kHz de sortie, le HE-AAC n'existe plus en pratique (et la règle 2.4 d'Apple le veut sous
  // 64 kb/s) : un « SBR » sur un cœur à 32 kHz ou plus serait une lecture fausse plutôt qu'un fichier réel.
  const extension = AAC_RATES[core.frequencyIndex] * 2 > 48000 ? -1 : AAC_RATES.indexOf(AAC_RATES[core.frequencyIndex] * 2);
  if (extension < 0) return null;
  return new BitWriter()
    .write(5, 5)
    .write(core.frequencyIndex, 4)
    .write(core.channelConfiguration, 4)
    .write(extension, 4)
    .write(2, 5)
    .write(core.frameLengthFlag, 1)
    .write(core.dependsOnCoreCoder, 1)
    .write(core.extensionFlag, 1)
    .align()
    .bytes();
}

// ── Le parcours d'une trame ──────────────────────────────────────────────────

const ELEMENT = { SCE: 0, CPE: 1, CCE: 2, LFE: 3, DSE: 4, PCE: 5, FIL: 6, END: 7 } as const;
const EIGHT_SHORT = 2;
const ZERO_BOOK = 0;
const NOISE_BOOK = 13;
const INTENSITY_BOOKS = new Set([14, 15]);
const EXT_DYNAMIC_RANGE = 11;
const EXT_SBR_DATA = 13;
const EXT_SBR_DATA_CRC = 14;

/** Un livre de Huffman prêt à lire : clé = (1 << longueur) + mot de code → indice. */
type HuffmanBook = { map: Map<number, number>; maxBits: number };
let books: HuffmanBook[] | null = null;
let scalefactorBook: HuffmanBook | null = null;

function bookOf(codes: readonly number[], bits: readonly number[]): HuffmanBook {
  const map = new Map<number, number>();
  codes.forEach((code, i) => map.set(2 ** bits[i] + code, i));
  return { map, maxBits: Math.max(...bits) };
}

function decode(r: BitReader, book: HuffmanBook): number {
  let key = 1;
  for (let n = 0; n < book.maxBits; n++) {
    key = key * 2 + r.bit();
    const index = book.map.get(key);
    if (index !== undefined) return index;
  }
  throw new AacSyntaxError("mot de code de Huffman inconnu");
}

function spectralBooks(): HuffmanBook[] {
  books ??= AAC_SPECTRAL_BOOKS.map((b) => bookOf(b.codes, b.bits));
  return books;
}

function scalefactors(): HuffmanBook {
  scalefactorBook ??= bookOf(AAC_SCALEFACTOR_CODES, AAC_SCALEFACTOR_BITS);
  return scalefactorBook;
}

interface IcsInfo {
  windowSequence: number;
  windowShape: number;
  maxSfb: number;
  /** Le nombre de fenêtres de chaque groupe (une seule fenêtre longue, ou les groupes des huit courtes). */
  groups: number[];
}

function readIcsInfo(r: BitReader, frequencyIndex: number): IcsInfo {
  if (r.read(1)) throw new AacSyntaxError("bit réservé de ics_info");
  const windowSequence = r.read(2);
  const windowShape = r.read(1);
  if (windowSequence === EIGHT_SHORT) {
    const maxSfb = r.read(4);
    const groups = [1];
    for (let i = 0; i < 7; i++) {
      if (r.read(1)) groups[groups.length - 1] += 1;
      else groups.push(1);
    }
    if (maxSfb > AAC_SWB_OFFSETS_SHORT[frequencyIndex].length - 1) throw new AacSyntaxError("max_sfb court hors bornes");
    return { windowSequence, windowShape, maxSfb, groups };
  }
  const maxSfb = r.read(6);
  // predictor_data_present : interdit en AAC-LC (FFmpeg : « Prediction is not allowed in AAC-LC »).
  if (r.read(1)) throw new AacSyntaxError("prédiction en AAC-LC");
  if (maxSfb > AAC_SWB_OFFSETS_LONG[frequencyIndex].length - 1) throw new AacSyntaxError("max_sfb long hors bornes");
  return { windowSequence, windowShape, maxSfb, groups: [1] };
}

/** individual_channel_stream (§4.6.2 ; `ff_aac_decode_ics` de FFmpeg), parcouru sans rien déquantifier. */
function readIcs(r: BitReader, frequencyIndex: number, common: IcsInfo | null): IcsInfo {
  r.skip(8); // global_gain
  const info = common ?? readIcsInfo(r, frequencyIndex);
  const short = info.windowSequence === EIGHT_SHORT;
  const offsets = (short ? AAC_SWB_OFFSETS_SHORT : AAC_SWB_OFFSETS_LONG)[frequencyIndex];

  // section_data : un livre par plage de bandes, par groupe.
  const bandBooks: number[][] = [];
  const lengthBits = short ? 3 : 5;
  const escape = (1 << lengthBits) - 1;
  for (let g = 0; g < info.groups.length; g++) {
    const row: number[] = [];
    while (row.length < info.maxSfb) {
      const book = r.read(4);
      if (book === 12) throw new AacSyntaxError("livre réservé 12");
      let length = 0;
      let increment: number;
      do {
        increment = r.read(lengthBits);
        length += increment;
      } while (increment === escape);
      if (row.length + length > info.maxSfb) throw new AacSyntaxError("section au-delà de max_sfb");
      for (let i = 0; i < length; i++) row.push(book);
    }
    bandBooks.push(row);
  }

  // scale_factor_data : le premier bruit en 9 bits bruts, tout le reste par le livre des facteurs.
  let firstNoise = true;
  for (const row of bandBooks) {
    for (const book of row) {
      if (book === ZERO_BOOK) continue;
      if (book === NOISE_BOOK && firstNoise) {
        r.skip(9);
        firstNoise = false;
      } else decode(r, scalefactors());
    }
  }

  // pulse_data
  if (r.read(1)) {
    if (short) throw new AacSyntaxError("impulsions en fenêtres courtes");
    const pulses = r.read(2) + 1;
    r.skip(6); // pulse_start_sfb
    r.skip(pulses * 9); // offset (5) + amp (4)
  }
  // tns_data
  if (r.read(1)) {
    for (let w = 0; w < (short ? 8 : 1); w++) {
      const filters = r.read(short ? 1 : 2);
      if (!filters) continue;
      const coefRes = r.read(1);
      for (let f = 0; f < filters; f++) {
        r.skip(short ? 4 : 6); // length
        const order = r.read(short ? 3 : 5);
        if (!order) continue;
        r.skip(1); // direction
        const compress = r.read(1);
        r.skip(order * (coefRes + 3 - compress));
      }
    }
  }
  // gain_control_data : profil SSR seulement — jamais dans un LC.
  if (r.read(1)) throw new AacSyntaxError("contrôle de gain (SSR)");

  // spectral_data : par groupe, par bande, par fenêtre du groupe, des quadruplets (livres 1 à 4) ou des
  // paires (5 à 11) ; un bit de signe par valeur non nulle des livres non signés, puis les échappements
  // du livre 11 (valeur 16).
  const spectral = spectralBooks();
  info.groups.forEach((windows, g) => {
    for (let sfb = 0; sfb < info.maxSfb; sfb++) {
      const book = bandBooks[g][sfb];
      if (book === ZERO_BOOK || book === NOISE_BOOK || INTENSITY_BOOKS.has(book)) continue;
      const width = offsets[sfb + 1] - offsets[sfb];
      const quads = book <= 4;
      const unsigned = !(book === 1 || book === 2 || book === 5 || book === 6);
      const base = book <= 2 ? 3 : book <= 4 ? 3 : book <= 6 ? 9 : book <= 8 ? 8 : book <= 10 ? 13 : 17;
      for (let w = 0; w < windows; w++) {
        for (let k = 0; k < width; k += quads ? 4 : 2) {
          let index = decode(r, spectral[book - 1]);
          const values: number[] = [];
          for (let v = 0; v < (quads ? 4 : 2); v++) {
            values.unshift(index % base);
            index = Math.floor(index / base);
          }
          if (!unsigned) continue;
          for (const v of values) if (v !== 0) r.skip(1);
          if (book === 11) {
            for (const v of values) {
              if (v !== 16) continue;
              let ones = 0;
              while (r.bit()) if (++ones > 8) throw new AacSyntaxError("échappement trop long");
              r.skip(ones + 4);
            }
          }
        }
      }
    }
  });
  return info;
}

/** Les octets consommés par une charge EXT_DYNAMIC_RANGE (`decode_dynamic_range` de FFmpeg), type compris. */
function readDynamicRange(r: BitReader): number {
  let n = 1;
  if (r.read(1)) {
    r.skip(8);
    n++;
  }
  if (r.read(1)) {
    let excluded = 0;
    do {
      r.skip(7);
      excluded += 7;
    } while (excluded < 64 - 7 && r.read(1));
    n += excluded / 7;
  }
  let bands = 1;
  if (r.read(1)) {
    bands += r.read(4);
    r.skip(4);
    n++;
    r.skip(8 * bands);
    n += bands;
  }
  if (r.read(1)) {
    r.skip(8);
    n++;
  }
  r.skip(8 * bands);
  return n + bands;
}

export interface AacElement {
  type: "SCE" | "CPE" | "LFE";
  tag: number;
  /** La suite de fenêtres de chaque canal (une pour SCE/LFE, deux pour CPE). */
  windowSequences: number[];
  /** Un élément FIL portant des données SBR le suit. */
  sbr: boolean;
  /** Où l'élément finit, en bits depuis le début de la trame (les tests y insèrent un FIL). */
  endBit: number;
}

export interface RawDataBlock {
  elements: AacElement[];
  /** Bits lus jusqu'à END compris. */
  bits: number;
  /** Le parcours tombe exactement sur la fin de la trame (END dans son dernier octet). */
  exact: boolean;
}

/**
 * Le parcours d'un raw_data_block d'AAC-LC (§4.4.2.1, `decode_frame_ga` de FFmpeg) : chaque élément de
 * canaux, et pour chacun, si un FIL de données SBR le suit. Lève `AacSyntaxError` sur ce que le module ne
 * sait pas parcourir (couplage CCE, PCE dans le flux, prédiction, SSR) ou sur une trame qui ne tombe pas juste.
 *
 * @param frequencyIndex L'indice de fréquence **du cœur** (celui de la configuration) : les bandes en dépendent.
 */
export function readRawDataBlock(frame: Uint8Array, frequencyIndex: number): RawDataBlock {
  const r = new BitReader(frame);
  const elements: AacElement[] = [];
  let previous: AacElement | null = null;
  for (;;) {
    const type = r.read(3);
    if (type === ELEMENT.END) break;
    const tag = r.read(4);
    switch (type) {
      case ELEMENT.SCE:
      case ELEMENT.LFE: {
        const info = readIcs(r, frequencyIndex, null);
        previous = { type: type === ELEMENT.SCE ? "SCE" : "LFE", tag, windowSequences: [info.windowSequence], sbr: false, endBit: r.pos };
        elements.push(previous);
        break;
      }
      case ELEMENT.CPE: {
        let common: IcsInfo | null = null;
        if (r.read(1)) {
          common = readIcsInfo(r, frequencyIndex);
          const ms = r.read(2);
          if (ms === 3) throw new AacSyntaxError("ms_mask_present réservé");
          if (ms === 1) r.skip(common.groups.length * common.maxSfb);
        }
        const left = readIcs(r, frequencyIndex, common);
        const right = readIcs(r, frequencyIndex, common);
        previous = { type: "CPE", tag, windowSequences: [left.windowSequence, right.windowSequence], sbr: false, endBit: r.pos };
        elements.push(previous);
        break;
      }
      case ELEMENT.DSE: {
        const align = r.read(1);
        let count = r.read(8);
        if (count === 255) count += r.read(8);
        if (align) r.align();
        r.skip(8 * count);
        break;
      }
      case ELEMENT.FIL: {
        let count = tag;
        if (count === 15) count += r.read(8) - 1;
        // Les charges d'extension se suivent dans le FIL (`decode_extension_payload`) : SBR et remplissage
        // prennent tout le reste, la plage dynamique compte ses octets.
        while (count > 0) {
          const extension = r.read(4);
          if (extension === EXT_SBR_DATA || extension === EXT_SBR_DATA_CRC) {
            if (!previous || previous.type === "LFE") throw new AacSyntaxError("SBR sans élément de canaux devant lui");
            previous.sbr = true;
            r.skip(8 * count - 4);
            count = 0;
          } else if (extension === EXT_DYNAMIC_RANGE) {
            count -= readDynamicRange(r);
            if (count < 0) throw new AacSyntaxError("plage dynamique plus longue que son FIL");
          } else {
            r.skip(8 * count - 4);
            count = 0;
          }
        }
        break;
      }
      default:
        // CCE (couplage) et PCE dans le flux : jamais vus ici, et rien de sûr à en dire sans les lire.
        throw new AacSyntaxError(type === ELEMENT.CCE ? "élément de couplage (CCE)" : "PCE dans le flux");
    }
  }
  const bits = r.pos;
  // Juste : END tombe dans le dernier octet de la trame. Le bourrage qui suit n'est pas jugé — la norme le veut
  // nul, mais des encodeurs y laissent des bits (*Skins*, *The Seven Deadly Sins* : 6 bits non nuls sur des
  // trames lues jusqu'au bout), et ni FFmpeg ni aucun décodeur ne le regarde. Un parcours faux, lui, ne tombe
  // pas dans le dernier octet huit trames de suite.
  const exact = Math.ceil(bits / 8) === frame.length;
  return { elements, bits, exact };
}

// ── La décision ──────────────────────────────────────────────────────────────

/** Les éléments de canaux d'une configuration 1 à 7, dans l'ordre (ISO/IEC 14496-3, tableau 1.19). */
const CONFIGURATION_ELEMENTS: Record<number, ("SCE" | "CPE" | "LFE")[]> = {
  1: ["SCE"],
  2: ["CPE"],
  3: ["SCE", "CPE"],
  4: ["SCE", "CPE", "SCE"],
  5: ["SCE", "CPE", "CPE"],
  6: ["SCE", "CPE", "CPE", "LFE"],
  7: ["SCE", "CPE", "CPE", "CPE", "LFE"],
};

/** Canaux d'une configuration (7 est le 7.1, huit canaux). */
export const AAC_CONFIGURATION_CHANNELS: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 8 };

export type AacHlsPlan =
  /** Rien à changer : la configuration est copiée telle quelle. */
  | { kind: "copie"; core: AscFacts | null }
  /** SBR implicite trouvé dans le flux : la configuration est réécrite en hiérarchique. */
  | { kind: "sbr-explicite"; core: AscFacts; configuration: Uint8Array; sampleRate: number; channels: number }
  | { kind: "refus"; reason: "son-aac-sbr-implicite" | "son-aac-ps-implicite"; detail: string };

/**
 * Ce qu'il faut faire d'une piste AAC pour le HLS, d'après sa configuration et ses premières trames
 * (au moins la première : c'est sur elle qu'un décodeur décide du SBR implicite).
 *
 * @param containerRate La fréquence que le conteneur annonce (`OutputSamplingFrequency` d'abord) : un
 *   indice seulement. Le double du cœur sans SBR dans le flux est une contradiction, et refusé.
 */
export function aacHlsPlan(asc: Uint8Array, frames: readonly Uint8Array[], containerRate: number): AacHlsPlan {
  const core = readAsc(asc);
  if (!core || core.coreObjectType !== 2 || core.sbr === "hierarchique") return { kind: "copie", core };
  const coreRate = AAC_RATES[core.frequencyIndex];
  const suspected = Math.round(containerRate) === coreRate * 2 || core.sbr === "synchro";
  // Le flux, trame par trame : toutes doivent être lues jusqu'au bout et dire la même chose.
  const verdicts: ("sbr" | "lc")[] = [];
  let unreadable: string | null = null;
  for (const frame of frames) {
    try {
      const block = readRawDataBlock(frame, core.frequencyIndex);
      if (!block.exact) {
        unreadable = `trame lue sur ${block.bits} bits pour ${frame.length * 8}`;
        break;
      }
      const channelElements = block.elements.filter((e) => e.type !== "LFE");
      const withSbr = channelElements.filter((e) => e.sbr).length;
      if (withSbr !== 0 && withSbr !== channelElements.length) {
        unreadable = `SBR derrière ${withSbr} élément(s) sur ${channelElements.length}`;
        break;
      }
      verdicts.push(withSbr ? "sbr" : "lc");
    } catch (error) {
      unreadable = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  if (unreadable !== null || verdicts.length === 0) {
    // Un LC que rien ne désigne comme HE-AAC reste copié comme avant : le parcours n'ajoute qu'une
    // information, il ne retire pas une piste servie sur un flux qu'il ne sait pas lire.
    return suspected ? { kind: "refus", reason: "son-aac-sbr-implicite", detail: `flux illisible : ${unreadable ?? "aucune trame"}` } : { kind: "copie", core };
  }
  if (verdicts.some((v) => v !== verdicts[0])) return { kind: "refus", reason: "son-aac-sbr-implicite", detail: "trames en désaccord sur le SBR" };
  if (verdicts[0] === "lc") {
    // Pas de SBR dans le flux. Le conteneur qui annonce le double se trompe : le décodeur jouera du LC à la
    // fréquence du cœur, et l'init annoncerait le double — on ne sert pas une histoire contradictoire.
    return suspected ? { kind: "refus", reason: "son-aac-sbr-implicite", detail: "aucun SBR dans le flux, fréquence double annoncée" } : { kind: "copie", core };
  }
  if (core.sbr === "absent") return { kind: "refus", reason: "son-aac-sbr-implicite", detail: "SBR présent dans le flux, annoncé absent" };
  if (core.channelConfiguration === 1) {
    return { kind: "refus", reason: "son-aac-ps-implicite", detail: "cœur mono : stéréo paramétrique (HE-AAC v2) indécidable sans décoder le SBR" };
  }
  if (core.frameLengthFlag || core.dependsOnCoreCoder || core.extensionFlag) {
    return { kind: "refus", reason: "son-aac-sbr-implicite", detail: "GASpecificConfig inhabituelle" };
  }
  const configuration = explicitSbrConfig(core);
  if (!configuration) return { kind: "refus", reason: "son-aac-sbr-implicite", detail: `cœur à ${coreRate} Hz` };
  return { kind: "sbr-explicite", core, configuration, sampleRate: coreRate * 2, channels: AAC_CONFIGURATION_CHANNELS[core.channelConfiguration] };
}

// ── Le silence ───────────────────────────────────────────────────────────────

/**
 * Une trame AAC-LC silencieuse pour une configuration de canaux 1 à 7 : chaque élément en fenêtre longue
 * (`ONLY_LONG_SEQUENCE`, fenêtre sinus), `max_sfb` = 0, sans impulsion, TNS ni contrôle de gain ; une CPE à
 * fenêtre commune sans masque M/S. `global_gain` vaut 100 (sans bande, il ne pèse sur rien). Null pour une
 * autre configuration.
 */
export function silentAacFrame(channelConfiguration: number): Uint8Array | null {
  const layout = CONFIGURATION_ELEMENTS[channelConfiguration];
  if (!layout) return null;
  const w = new BitWriter();
  const icsInfo = () => w.write(0, 1).write(0, 2).write(0, 1).write(0, 6).write(0, 1); // réservé, ONLY_LONG, sinus, max_sfb, pas de prédiction
  const icsBody = () => w.write(0, 1).write(0, 1).write(0, 1); // ni impulsion, ni TNS, ni contrôle de gain
  const tags = { SCE: 0, CPE: 0, LFE: 0 };
  for (const type of layout) {
    const tag = tags[type]++;
    if (type === "CPE") {
      w.write(ELEMENT.CPE, 3).write(tag, 4).write(1, 1);
      icsInfo();
      w.write(0, 2); // ms_mask_present
      for (let ch = 0; ch < 2; ch++) {
        w.write(100, 8);
        icsBody();
      }
    } else {
      w.write(type === "SCE" ? ELEMENT.SCE : ELEMENT.LFE, 3).write(tag, 4).write(100, 8);
      icsInfo();
      icsBody();
    }
  }
  w.write(ELEMENT.END, 3).align();
  return w.bytes();
}

/**
 * Une trame dont un silence peut suivre : aucun canal en fenêtre `LONG_START` ni `EIGHT_SHORT` — après elles,
 * la norme veut des fenêtres courtes ou `LONG_STOP`, et la trame de silence est longue. Null si la trame ne
 * se lit pas.
 */
export function silenceMayFollow(frame: Uint8Array, frequencyIndex: number): boolean | null {
  try {
    const block = readRawDataBlock(frame, frequencyIndex);
    return block.elements.every((e) => e.windowSequences.every((s) => s === 0 || s === 3));
  } catch {
    return null;
  }
}
