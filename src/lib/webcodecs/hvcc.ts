import type { ByteSource } from "./byteSource";
import type { MatroskaFile, MatroskaTrack } from "./matroska";
import { SampleReader } from "./sampleReader";
import { nalLengthSize } from "./codecConfig";

/**
 * L'en-tête HEVC d'un fichier, corrigé par ce que ses images disent vraiment.
 *
 * Trouvé le 21/09/2026 sur *Dirty Dancing* : son en-tête (le `hvcC` de Matroska) déclare un jeu
 * de paramètres d'image (PPS) — et la toute première image du film en porte un **autre**, sous le
 * même numéro, que toutes les images suivantes utilisent. Un décodeur qui lit les paramètres dans
 * les images (ffmpeg) ne voit rien. Safari, lui, reçoit ce flux étiqueté `hvc1`, forme sous
 * laquelle il ne prend ses paramètres **que** dans l'en-tête : il décodait tout le film avec le
 * mauvais PPS, tenait quelques secondes, puis « Media failed to decode » — trois reconstructions
 * et le lecteur serveur. *Le Parrain*, qui porte le même PPS dans l'en-tête et dans le flux, jouait.
 *
 * La correction se fait une fois, à l'ouverture : on lit les jeux de paramètres (VPS, SPS, PPS)
 * que porte la première image, et s'ils diffèrent de l'en-tête, on reconstruit celui-ci avec eux.
 * Le reste de l'en-tête — profil, niveau, format, messages SEI — est gardé tel quel. Un fichier
 * dont l'en-tête dit déjà vrai est rendu à l'identique, à l'octet près.
 *
 * Servi aux deux chemins : le remultiplexage l'écrit dans l'entrée d'échantillon, le canevas le
 * donne à `VideoDecoder` comme `description` — le même en-tête, lu de la même façon.
 */

const VPS = 32;
const SPS = 33;
const PPS = 34;
const PARAMETER_SETS = [VPS, SPS, PPS];

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Les VPS/SPS/PPS portés par une image (NAL préfixés par leur longueur), dans leur ordre. */
export function parameterSetsIn(sample: Uint8Array, nalLength: number): Map<number, Uint8Array[]> {
  const found = new Map<number, Uint8Array[]>();
  let at = 0;
  while (at + nalLength <= sample.length) {
    let length = 0;
    for (let i = 0; i < nalLength; i++) length = length * 256 + sample[at + i];
    at += nalLength;
    if (length <= 0 || at + length > sample.length) break;
    const nal = sample.subarray(at, at + length);
    const type = (nal[0] >> 1) & 0x3f;
    if (PARAMETER_SETS.includes(type)) {
      const list = found.get(type) ?? [];
      if (!list.some((known) => same(known, nal))) list.push(nal);
      found.set(type, list);
    }
    at += length;
  }
  return found;
}

interface HvccArray {
  header: number;
  nals: Uint8Array[];
}

function readArrays(hvcc: Uint8Array): HvccArray[] | null {
  if (hvcc.length < 23) return null;
  const arrays: HvccArray[] = [];
  let at = 23;
  for (let a = 0; a < hvcc[22]; a++) {
    if (at + 3 > hvcc.length) return null;
    const header = hvcc[at];
    const count = (hvcc[at + 1] << 8) | hvcc[at + 2];
    at += 3;
    const nals: Uint8Array[] = [];
    for (let n = 0; n < count; n++) {
      if (at + 2 > hvcc.length) return null;
      const length = (hvcc[at] << 8) | hvcc[at + 1];
      at += 2;
      if (at + length > hvcc.length) return null;
      nals.push(hvcc.subarray(at, at + length));
      at += length;
    }
    arrays.push({ header, nals });
  }
  return arrays;
}

/**
 * L'en-tête corrigé, ou `null` s'il n'y a rien à corriger — ou rien de lisible, auquel cas on ne
 * touche à rien : mieux vaut l'en-tête du fichier qu'un en-tête deviné.
 */
export function reconcileHvcc(hvcc: Uint8Array, keyframe: Uint8Array, nalLength: number): Uint8Array | null {
  const arrays = readArrays(hvcc);
  if (!arrays) return null;
  const inBand = parameterSetsIn(keyframe, nalLength);
  if (inBand.size === 0) return null;

  let changed = false;
  const next: HvccArray[] = arrays.map((array) => {
    const type = array.header & 0x3f;
    const truth = inBand.get(type);
    if (!truth) return array;
    const identical = truth.length === array.nals.length && truth.every((nal, i) => same(nal, array.nals[i]));
    if (identical) return array;
    changed = true;
    // array_completeness (bit de poids fort) gardé : il dit si le flux peut en porter d'autres.
    return { header: array.header, nals: truth };
  });
  // Un type porté par l'image et absent de l'en-tête : ajouté, dans l'ordre VPS, SPS, PPS.
  for (const type of PARAMETER_SETS) {
    if (inBand.has(type) && !next.some((array) => (array.header & 0x3f) === type)) {
      next.push({ header: 0x80 | type, nals: inBand.get(type)! });
      changed = true;
    }
  }
  if (!changed) return null;

  const size = 23 + next.reduce((n, array) => n + 3 + array.nals.reduce((m, nal) => m + 2 + nal.length, 0), 0);
  const out = new Uint8Array(size);
  out.set(hvcc.subarray(0, 22), 0);
  out[22] = next.length;
  let at = 23;
  for (const array of next) {
    out[at] = array.header;
    out[at + 1] = array.nals.length >> 8;
    out[at + 2] = array.nals.length & 0xff;
    at += 3;
    for (const nal of array.nals) {
      out[at] = nal.length >> 8;
      out[at + 1] = nal.length & 0xff;
      out.set(nal, at + 2);
      at += 2 + nal.length;
    }
  }
  return out;
}

/** Jusqu'où chercher la première image de la piste avant de renoncer. */
const PROBE_SAMPLES = 400;

/**
 * La piste vidéo, avec l'en-tête que ses images justifient. Pour le HEVC seulement ; toute autre
 * piste, ou un fichier illisible à cet endroit, est rendue telle quelle.
 */
export async function withTrueParameterSets(
  source: ByteSource,
  file: MatroskaFile,
  track: MatroskaTrack
): Promise<MatroskaTrack> {
  if (track.codecId !== "V_MPEGH/ISO/HEVC" || !track.codecPrivate) return track;
  const start = file.firstClusterOffset ?? file.segmentDataStart;
  try {
    const reader = new SampleReader(source, file, start);
    for (let i = 0; i < PROBE_SAMPLES; i++) {
      const sample = await reader.next();
      if (!sample) return track;
      if (sample.trackNumber !== track.number) continue;
      const fixed = reconcileHvcc(track.codecPrivate, sample.data, nalLengthSize(track.codecId, track.codecPrivate));
      return fixed ? { ...track, codecPrivate: fixed } : track;
    }
  } catch {
    // Une sonde qui échoue ne doit pas empêcher d'ouvrir le film : l'en-tête du fichier, comme avant.
  }
  return track;
}
